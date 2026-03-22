"""SSH session manager — owns all paramiko connections."""

from __future__ import annotations

import asyncio
import logging
import shlex
import socket
import time
from dataclasses import dataclass, field
from typing import Optional

import paramiko

logger = logging.getLogger("torrus.ssh")

OUTPUT_BUFFER_MAX = 10 * 1024  # 10 KB replay buffer per session
IDLE_TIMEOUT = 4 * 3600        # 4 hours
KEEPALIVE_INTERVAL = 30        # seconds
CLEANUP_INTERVAL = 300         # 5 minutes
CHANNEL_READ_TIMEOUT = 0.1     # seconds — blocking read timeout to avoid busy-wait


class _LoggingHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """Accept unknown host keys but log them cleanly instead of emitting a raw warning."""

    def missing_host_key(self, client, hostname, key):
        fingerprint = key.get_fingerprint().hex(":")
        logger.info("Accepted %s host key for %s: %s", key.get_name(), hostname, fingerprint)


@dataclass
class SSHSession:
    session_id: str
    tab_id: str
    client: paramiko.SSHClient
    channel: paramiko.Channel
    host: str
    username: str
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    cols: int = 220
    rows: int = 50
    read_task: Optional[asyncio.Task] = None
    output_buffer: bytearray = field(default_factory=bytearray)
    # False for cloned sessions — they share the transport and must not close it
    owns_client: bool = True


class SSHManager:
    def __init__(self, sio):
        self.sio = sio
        # (session_id, tab_id) -> SSHSession
        self._sessions: dict[tuple[str, str], SSHSession] = {}
        # socket.io sid -> set of (session_id, tab_id) keys
        self._sid_map: dict[str, set[tuple[str, str]]] = {}
        self._lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []

    def start_background_tasks(self):
        self._tasks.append(asyncio.create_task(self._keepalive_loop()))
        self._tasks.append(asyncio.create_task(self._cleanup_loop()))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def connect(
        self,
        sid: str,
        session_id: str,
        tab_id: str,
        host: str,
        port: int,
        username: str,
        password: str,
        cols: int = 220,
        rows: int = 50,
    ) -> None:
        key = (session_id, tab_id)
        room = _room(session_id, tab_id)

        await self._destroy_session(key)

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(_LoggingHostKeyPolicy())

        loop = asyncio.get_running_loop()
        target = f"{username}@{host}:{port}"
        logger.info("Connecting to %s (session=%s, tab=%s)", target, session_id, tab_id)

        try:
            await loop.run_in_executor(
                None,
                lambda: client.connect(
                    hostname=host,
                    port=port,
                    username=username,
                    password=password,
                    timeout=15,
                    banner_timeout=15,
                    auth_timeout=15,
                    look_for_keys=False,
                    allow_agent=False,
                ),
            )
        except paramiko.AuthenticationException:
            logger.warning("Auth failed for %s", target)
            await self.sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": "Authentication failed. Check username and password.", "code": "auth_failed"},
                to=sid,
            )
            try:
                client.close()
            except Exception:
                pass
            return
        except paramiko.SSHException as exc:
            logger.warning("SSH error for %s: %s", target, exc)
            await self.sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": f"SSH error: {exc}", "code": "ssh_error"},
                to=sid,
            )
            try:
                client.close()
            except Exception:
                pass
            return
        except (socket.timeout, TimeoutError):
            logger.warning("Connection to %s timed out", target)
            await self.sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": "Connection timed out after 15 seconds.", "code": "timeout"},
                to=sid,
            )
            try:
                client.close()
            except Exception:
                pass
            return
        except OSError as exc:
            logger.warning("Cannot reach %s: %s", target, exc)
            await self.sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": f"Cannot reach host: {exc}", "code": "host_unreachable"},
                to=sid,
            )
            try:
                client.close()
            except Exception:
                pass
            return

        # Silently check for tmux on a separate channel (invisible to user)
        has_tmux = await self._check_tmux(client)
        tmux_name = f"sc_{session_id.replace('-', '')}_{tab_id}" if has_tmux else None

        try:
            if tmux_name:
                # Start tmux directly — user never sees a detection command
                channel = await loop.run_in_executor(
                    None,
                    lambda: _open_tmux_channel(client, tmux_name, cols, rows),
                )
            else:
                channel = await loop.run_in_executor(
                    None,
                    lambda: client.invoke_shell(
                        term="xterm-256color",
                        width=cols,
                        height=rows,
                        environment={"COLORTERM": "truecolor", "TERM": "xterm-256color"},
                    ),
                )
        except Exception as exc:
            await self.sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": f"Failed to open shell: {exc}", "code": "shell_error"},
                to=sid,
            )
            try:
                client.close()
            except Exception:
                pass
            return

        channel.settimeout(CHANNEL_READ_TIMEOUT)

        session = SSHSession(
            session_id=session_id,
            tab_id=tab_id,
            client=client,
            channel=channel,
            host=host,
            username=username,
            cols=cols,
            rows=rows,
        )

        async with self._lock:
            self._sessions[key] = session
            self._sid_map.setdefault(sid, set()).add(key)

        await self.sio.enter_room(sid, room)

        session.read_task = asyncio.create_task(self._read_loop(session))

        mode = "tmux" if tmux_name else "shell"
        logger.info("Connected to %s (%s)", target, mode)

        await self.sio.emit(
            "ssh:connected",
            {"tab_id": tab_id, "message": f"Connected to {username}@{host}"},
            to=sid,
        )

    async def restore_session(self, sid: str, session_id: str, tab_id: str) -> str:
        """Re-attach a socket to an existing SSH session. Returns 'active' or 'dead'."""
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
            if session is None or session.channel.closed:
                return "dead"

            self._sid_map.setdefault(sid, set()).add(key)

        room = _room(session_id, tab_id)
        await self.sio.enter_room(sid, room)

        # Replay buffered output (sanitized to strip truncated alt-screen content)
        if session.output_buffer:
            replay = _sanitize_replay_buffer(bytes(session.output_buffer))
            if replay:
                await self.sio.emit(
                    "ssh:output",
                    {"tab_id": tab_id, "data": replay},
                    to=sid,
                )

        return "active"

    async def force_redraw(self, session_id: str, tab_id: str) -> None:
        """Toggle PTY size to send SIGWINCH, forcing the remote shell to redraw."""
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(
                None, session.channel.resize_pty, session.cols + 1, session.rows,
            )
            await loop.run_in_executor(
                None, session.channel.resize_pty, session.cols, session.rows,
            )
        except Exception:
            pass

    async def handle_input(self, session_id: str, tab_id: str, data: str | bytes) -> None:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return

        if isinstance(data, str):
            data = data.encode("utf-8", errors="replace")

        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, session.channel.send, data)
            session.last_activity = time.time()
        except Exception as exc:
            logger.warning("send error for %s/%s: %s", session_id, tab_id, exc)

    async def handle_resize(self, session_id: str, tab_id: str, cols: int, rows: int) -> None:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return

        session.cols = cols
        session.rows = rows
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, session.channel.resize_pty, cols, rows)
        except Exception:
            pass

    async def disconnect_session(self, session_id: str, tab_id: str) -> None:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session:
            logger.info("Disconnecting %s@%s (tab=%s)", session.username, session.host, tab_id)
        await self._destroy_session(key)

    async def clone(
        self,
        sid: str,
        session_id: str,
        source_tab_id: str,
        new_tab_id: str,
        cols: int = 220,
        rows: int = 50,
    ) -> None:
        """Open a new shell channel on the same SSH transport as an existing session."""
        source_key = (session_id, source_tab_id)
        new_key = (session_id, new_tab_id)
        room = _room(session_id, new_tab_id)

        async with self._lock:
            source = self._sessions.get(source_key)
            if source is None or source.channel.closed:
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": new_tab_id, "message": "Source session is no longer active.", "code": "clone_failed"},
                    to=sid,
                )
                return
            # Copy references under lock so source can't be destroyed while we use them
            source_client = source.client
            source_host = source.host
            source_username = source.username

        loop = asyncio.get_running_loop()
        try:
            channel = await loop.run_in_executor(
                None,
                lambda: source_client.invoke_shell(
                    term="xterm-256color",
                    width=cols,
                    height=rows,
                    environment={"COLORTERM": "truecolor", "TERM": "xterm-256color"},
                ),
            )
        except Exception as exc:
            await self.sio.emit(
                "ssh:error",
                {"tab_id": new_tab_id, "message": f"Failed to clone session: {exc}", "code": "clone_failed"},
                to=sid,
            )
            return

        channel.settimeout(CHANNEL_READ_TIMEOUT)

        session = SSHSession(
            session_id=session_id,
            tab_id=new_tab_id,
            client=source_client,
            channel=channel,
            host=source_host,
            username=source_username,
            cols=cols,
            rows=rows,
            owns_client=False,  # shared transport — do not close on destroy
        )

        async with self._lock:
            self._sessions[new_key] = session
            self._sid_map.setdefault(sid, set()).add(new_key)

        await self.sio.enter_room(sid, room)
        session.read_task = asyncio.create_task(self._read_loop(session))

        logger.info("Cloned session %s@%s (tab=%s → %s)", source_username, source_host, source_tab_id, new_tab_id)

        await self.sio.emit(
            "ssh:connected",
            {"tab_id": new_tab_id, "message": f"Cloned from {source_username}@{source_host}"},
            to=sid,
        )

    def unmap_sid(self, sid: str) -> None:
        """Called on socket disconnect — does NOT destroy the SSH session."""
        self._sid_map.pop(sid, None)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _read_loop(self, session: SSHSession) -> None:
        room = _room(session.session_id, session.tab_id)
        loop = asyncio.get_running_loop()

        while not session.channel.closed:
            try:
                data = await loop.run_in_executor(None, _blocking_read, session.channel)
            except Exception as exc:
                await self.sio.emit(
                    "ssh:closed",
                    {"tab_id": session.tab_id, "reason": str(exc)},
                    room=room,
                )
                break

            if data:
                session.last_activity = time.time()
                session.output_buffer.extend(data)
                if len(session.output_buffer) > OUTPUT_BUFFER_MAX:
                    del session.output_buffer[: len(session.output_buffer) - OUTPUT_BUFFER_MAX]

                await self.sio.emit(
                    "ssh:output",
                    {"tab_id": session.tab_id, "data": data},
                    room=room,
                )
            # No sleep needed — _blocking_read blocks up to CHANNEL_READ_TIMEOUT

        await self.sio.emit(
            "ssh:closed",
            {"tab_id": session.tab_id, "reason": "Connection closed by remote host."},
            room=room,
        )
        async with self._lock:
            self._sessions.pop((session.session_id, session.tab_id), None)

    @staticmethod
    async def _check_tmux(client: paramiko.SSHClient) -> bool:
        """Silently check if tmux exists on the remote host using a separate channel."""
        try:
            loop = asyncio.get_running_loop()

            def _check():
                _, stdout, _ = client.exec_command("command -v tmux", timeout=5)
                out = stdout.read().decode().strip()
                stdout.channel.close()
                return len(out) > 0
            return await loop.run_in_executor(None, _check)
        except Exception:
            return False

    async def _destroy_session(self, key: tuple[str, str]) -> None:
        async with self._lock:
            await self._destroy_session_locked(key)

    async def _destroy_session_locked(self, key: tuple[str, str]) -> None:
        session = self._sessions.pop(key, None)
        if session is None:
            return
        if session.read_task and not session.read_task.done():
            session.read_task.cancel()
        try:
            session.channel.close()
        except Exception:
            pass
        if session.owns_client:
            try:
                session.client.close()
            except Exception:
                pass

    async def _keepalive_loop(self) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            async with self._lock:
                sessions = list(self._sessions.values())
            for session in sessions:
                try:
                    transport = session.channel.get_transport()
                    if transport and transport.is_active():
                        transport.send_ignore()
                except Exception:
                    pass

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL)
            now = time.time()
            async with self._lock:
                to_remove = [
                    key
                    for key, session in self._sessions.items()
                    if session.channel.closed or (now - session.last_activity) > IDLE_TIMEOUT
                ]
                for key in to_remove:
                    await self._destroy_session_locked(key)
            if to_remove:
                logger.info("Cleaned up %d idle/dead sessions", len(to_remove))


def _open_tmux_channel(
    client: paramiko.SSHClient, session_name: str, cols: int, rows: int
) -> paramiko.Channel:
    """Open a channel that runs tmux directly (no visible shell commands)."""
    transport = client.get_transport()
    channel = transport.open_session()
    channel.set_environment_variable("COLORTERM", "truecolor")
    channel.get_pty(term="xterm-256color", width=cols, height=rows)
    channel.exec_command(f"tmux new-session -A -s {shlex.quote(session_name)}")
    return channel


def _sanitize_replay_buffer(buf: bytes) -> bytes:
    """Strip orphaned alternate-screen content from a truncated replay buffer.

    When the 10 KB rolling buffer is trimmed it may lose the escape that
    *entered* the alternate screen while keeping everything drawn there plus
    the escape that *exits* it.  Replaying that into a fresh terminal draws
    the alt-screen content (e.g. vim's '~' lines) onto the main screen.

    This detects unmatched exits and returns only the bytes that follow them.
    """
    ENTERS = (b'\x1b[?1049h', b'\x1b[?47h', b'\x1b[?1047h')
    EXITS  = (b'\x1b[?1049l', b'\x1b[?47l', b'\x1b[?1047l')

    events: list[tuple[int, bool, int]] = []  # (position, is_enter, seq_len)
    for seq in ENTERS:
        start = 0
        while True:
            idx = buf.find(seq, start)
            if idx == -1:
                break
            events.append((idx, True, len(seq)))
            start = idx + len(seq)
    for seq in EXITS:
        start = 0
        while True:
            idx = buf.find(seq, start)
            if idx == -1:
                break
            events.append((idx, False, len(seq)))
            start = idx + len(seq)

    if not events:
        return buf

    events.sort()

    depth = 0
    trim_to = 0
    for pos, is_enter, length in events:
        if is_enter:
            depth += 1
        elif depth > 0:
            depth -= 1
        else:
            # Unmatched exit — everything before was alt-screen garbage
            trim_to = pos + length

    return buf[trim_to:] if trim_to else buf


def _room(session_id: str, tab_id: str) -> str:
    return f"session:{session_id}:{tab_id}"


def _blocking_read(channel: paramiko.Channel) -> bytes:
    """Called in thread executor. Blocks up to CHANNEL_READ_TIMEOUT for data."""
    if channel.closed:
        raise ConnectionError("Channel closed")
    try:
        data = channel.recv(4096)
        if not data:
            raise ConnectionError("Remote process exited")
        return data
    except socket.timeout:
        if channel.exit_status_ready():
            raise ConnectionError("Remote process exited")
        return b""
