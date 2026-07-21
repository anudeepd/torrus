"""SSH session manager — owns all paramiko connections."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import shlex
import socket
import time
import os
from dataclasses import dataclass, field
from collections.abc import Awaitable, Callable
from typing import Optional

import paramiko

logger = logging.getLogger("torrus.ssh")

OUTPUT_BUFFER_MAX = 10 * 1024  # 10 KB replay buffer per session
IDLE_TIMEOUT = 4 * 3600        # 4 hours
KEEPALIVE_INTERVAL = 30        # seconds
CLEANUP_INTERVAL = 300         # 5 minutes
CHANNEL_READ_TIMEOUT = 0.1     # seconds — blocking read timeout to avoid busy-wait


class _WarnThenAddPolicy(paramiko.MissingHostKeyPolicy):
    """Warn on first encounter, then add the host key to known_hosts."""

    def __init__(self, known_hosts: paramiko.HostKeys | None = None):
        self._known_hosts = known_hosts

    def missing_host_key(self, client, hostname, key):
        fingerprint = key.get_fingerprint().hex(":")
        if self._known_hosts is not None:
            self._known_hosts.add(hostname, key.get_name(), key)
        logger.warning(
            "Adding new host key for %s (%s): %s",
            hostname,
            key.get_name(),
            fingerprint,
        )


@dataclass
class SSHSession:
    session_id: str
    tab_id: str
    client: paramiko.SSHClient
    channel: paramiko.Channel
    host: str
    port: int
    username: str
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    cols: int = 220
    rows: int = 50
    read_task: Optional[asyncio.Task] = None
    write_task: Optional[asyncio.Task] = None
    input_queue: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(maxsize=65536))
    output_buffer: bytearray = field(default_factory=bytearray)
    # Probed at connection time; SFTP identity is scoped to the SSH transport.
    is_root: bool = False
    # Recomputed during teardown: close the client only when no remaining
    # session still shares its transport.
    owns_client: bool = True


class SSHManager:
    def __init__(
        self,
        sio,
        on_disconnect: Callable[[str], Awaitable[None]] | None = None,
        max_workers: int | None = None,
    ):
        self.sio = sio
        self._on_disconnect = on_disconnect
        # (session_id, tab_id) -> SSHSession
        self._sessions: dict[tuple[str, str], SSHSession] = {}
        # socket.io sid -> set of (session_id, tab_id) keys
        self._sid_map: dict[str, set[tuple[str, str]]] = {}
        self._lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []
        # Prevent concurrent connect() calls for the same (session_id, tab_id)
        self._pending_keys: set[tuple[str, str]] = set()
        # Dedicated thread pool for SSH blocking I/O — isolates from default executor
        workers = max_workers or max(32, min(128, (os.cpu_count() or 4) * 8))
        self._ssh_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="ssh"
        )

    def start_background_tasks(self):
        self._tasks.append(asyncio.create_task(self._keepalive_loop()))
        self._tasks.append(asyncio.create_task(self._cleanup_loop()))

    async def stop_background_tasks(self):
        for task in self._tasks:
            if not task.done():
                task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()

        for key in list(self._sessions.keys()):
            await self._destroy_session(key)

        await asyncio.sleep(0)
        self._ssh_executor.shutdown(wait=False, cancel_futures=True)

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
        password: str | bytearray,
        cols: int = 220,
        rows: int = 50,
    ) -> None:
        password_buffer = password if isinstance(password, bytearray) else bytearray(password, "utf-8")
        key = (session_id, tab_id)
        room = _room(session_id, tab_id)

        async with self._lock:
            if key in self._pending_keys:
                logger.warning("Connection already in progress for %s", key)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "Connection already in progress.", "code": "connect_in_progress"},
                    to=sid,
                )
                return
            self._pending_keys.add(key)
            old_session = self._pop_session_locked(key)
        if old_session is not None:
            await self._close_session(old_session)

        client: paramiko.SSHClient | None = None
        connection_succeeded = False
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(_WarnThenAddPolicy())

            loop = asyncio.get_running_loop()
            target = f"{username}@{host}:{port}"
            logger.info("Connecting to %s (session=%s, tab=%s)", target, session_id, tab_id)

            try:
                has_tmux, is_root = await loop.run_in_executor(
                    self._ssh_executor,
                    lambda: _connect_and_check_tmux(client, host, port, username, password_buffer),
                )
            except paramiko.AuthenticationException:
                logger.warning("Auth failed for %s", target)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "Authentication failed. Check username and password.", "code": "auth_failed"},
                    to=sid,
                )
                return
            except paramiko.SSHException:
                logger.warning("SSH error for %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "SSH connection failed.", "code": "ssh_error"},
                    to=sid,
                )
                return
            except (socket.timeout, TimeoutError):
                logger.warning("Connection to %s timed out", target)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "Connection timed out after 15 seconds.", "code": "timeout"},
                    to=sid,
                )
                return
            except OSError:
                logger.warning("Cannot reach %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "Cannot reach host.", "code": "host_unreachable"},
                    to=sid,
                )
                return

            tmux_name = f"sc_{session_id.replace('-', '')}_{tab_id}" if has_tmux else None

            try:
                if tmux_name:
                    channel = await loop.run_in_executor(
                        self._ssh_executor,
                        lambda: _open_tmux_channel(client, tmux_name, cols, rows),
                    )
                else:
                    channel = client.invoke_shell(
                        term="xterm-256color",
                        width=cols,
                        height=rows,
                        environment={"COLORTERM": "truecolor", "TERM": "xterm-256color"},
                    )
            except Exception:
                logger.warning("Failed to open shell for %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": tab_id, "message": "Failed to open remote shell.", "code": "shell_error"},
                    to=sid,
                )
                return

            channel.settimeout(CHANNEL_READ_TIMEOUT)

            session = SSHSession(
                session_id=session_id,
                tab_id=tab_id,
                client=client,
                channel=channel,
                host=host,
                port=port,
                username=username,
                is_root=is_root,
                cols=cols,
                rows=rows,
            )

            async with self._lock:
                self._sessions[key] = session
                self._sid_map.setdefault(sid, set()).add(key)

            await self.sio.enter_room(sid, room)

            session.read_task = asyncio.create_task(self._read_loop(session))
            session.write_task = asyncio.create_task(self._write_loop(session))

            mode = "tmux" if tmux_name else "shell"
            logger.info("Connected to %s (%s)", target, mode)

            await self.sio.emit(
                "ssh:connected",
                {"tab_id": tab_id, "message": f"Connected to {username}@{host}"},
                to=sid,
            )
            connection_succeeded = True
        finally:
            password_buffer[:] = b"\x00" * len(password_buffer)
            async with self._lock:
                self._pending_keys.discard(key)
            if not connection_succeeded and client is not None:
                try:
                    client.close()
                except Exception:
                    pass

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
        loop = asyncio.get_running_loop()
        async with self._lock:
            session = self._sessions.get(key)
            if session is None or session.channel.closed:
                return
            try:
                await loop.run_in_executor(
                    self._ssh_executor, session.channel.resize_pty, session.cols + 1, session.rows,
                )
                await loop.run_in_executor(
                    self._ssh_executor, session.channel.resize_pty, session.cols, session.rows,
                )
            except Exception:
                logger.warning("force_redraw failed for %s/%s", session_id, tab_id, exc_info=True)

    async def handle_input(self, session_id: str, tab_id: str, data: str | bytes) -> None:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return

        if isinstance(data, str):
            data = data.encode("utf-8", errors="replace")

        session.last_activity = time.time()
        await session.input_queue.put(data)

    async def get_session_target(self, session_id: str, tab_id: str) -> tuple[str, int, str] | None:
        """Return the active SSH target for audit attribution."""
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return None
            return session.host, session.port, session.username

    async def is_root_session(self, session_id: str, tab_id: str) -> bool:
        """Return whether the active SSH session has an effective UID of zero."""
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return False
            return session.is_root

    async def has_session(self, session_id: str) -> bool:
        """Return True when any active tab exists for this browser session."""
        async with self._lock:
            return any(key_session_id == session_id for key_session_id, _tab_id in self._sessions)

    async def open_sftp_channel(self, session_id: str, tab_id: str):
        """Open a new SFTP channel on an existing SSH transport."""
        loop = asyncio.get_running_loop()
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return None
            transport = session.client.get_transport()
            if transport is None or not transport.is_active():
                return None
            try:
                return await loop.run_in_executor(self._ssh_executor, transport.open_sftp_client)
            except AttributeError:
                return await loop.run_in_executor(self._ssh_executor, session.client.open_sftp)
            except Exception:
                logger.warning("Failed to open SFTP channel for %s/%s", session_id, tab_id, exc_info=True)
                return None

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
            await loop.run_in_executor(self._ssh_executor, session.channel.resize_pty, cols, rows)
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
            source_username = source.username
            source_host = source.host
            # Hold lock during invoke_shell to prevent source transport destruction
            loop = asyncio.get_running_loop()
            try:
                channel = await loop.run_in_executor(
                    self._ssh_executor,
                    lambda: source.client.invoke_shell(
                        term="xterm-256color",
                        width=cols,
                        height=rows,
                        environment={"COLORTERM": "truecolor", "TERM": "xterm-256color"},
                    ),
                )
            except Exception:
                logger.warning("Failed to clone session for %s", source_key, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {"tab_id": new_tab_id, "message": "Failed to clone session.", "code": "clone_failed"},
                    to=sid,
                )
                return

            channel.settimeout(CHANNEL_READ_TIMEOUT)

            session = SSHSession(
                session_id=session_id,
                tab_id=new_tab_id,
                client=source.client,
                channel=channel,
                host=source.host,
                port=source.port,
                username=source.username,
                is_root=source.is_root,
                cols=cols,
                rows=rows,
                owns_client=False,  # shared transport — do not close on destroy
            )

            self._sessions[new_key] = session
            self._sid_map.setdefault(sid, set()).add(new_key)

        await self.sio.enter_room(sid, room)
        session.read_task = asyncio.create_task(self._read_loop(session))
        session.write_task = asyncio.create_task(self._write_loop(session))

        logger.info("Cloned session %s@%s (tab=%s → %s)", source_username, source_host, source_tab_id, new_tab_id)

        await self.sio.emit(
            "ssh:connected",
            {"tab_id": new_tab_id, "message": f"Cloned from {source_username}@{source_host}"},
            to=sid,
        )

    def sid_session_count(self, sid: str) -> int:
        """Return the number of active SSH sessions owned by a socket id."""
        return len(self._sid_map.get(sid, set()))

    async def unmap_sid(self, sid: str) -> None:
        """Called on socket disconnect — does NOT destroy the SSH session."""
        keys = self._sid_map.pop(sid, set())
        for session_id, tab_id in keys:
            try:
                await self.sio.leave_room(sid, _room(session_id, tab_id))
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _read_loop(self, session: SSHSession) -> None:
        room = _room(session.session_id, session.tab_id)
        loop = asyncio.get_running_loop()

        while not session.channel.closed:
            try:
                data = await loop.run_in_executor(self._ssh_executor, _blocking_read, session.channel)
            except Exception:
                logger.warning("Read error for %s/%s", session.session_id, session.tab_id, exc_info=True)
                await self.sio.emit(
                    "ssh:closed",
                    {"tab_id": session.tab_id, "reason": "Connection closed."},
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
        # Cancel the paired write loop so it doesn't block on input_queue
        if session.write_task and not session.write_task.done():
            session.write_task.cancel()
        async with self._lock:
            self._sessions.pop((session.session_id, session.tab_id), None)
            still_connected = any(key[0] == session.session_id for key in self._sessions)
        if not still_connected and self._on_disconnect is not None:
            await self._on_disconnect(session.session_id)

    async def _write_loop(self, session: SSHSession) -> None:
        """Serialize all input writes to the SSH channel per session."""
        loop = asyncio.get_running_loop()

        while not session.channel.closed:
            try:
                data = await asyncio.wait_for(session.input_queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            if session.channel.closed:
                break

            try:
                await loop.run_in_executor(self._ssh_executor, _blocking_send_all, session.channel, data)
                session.last_activity = time.time()
            except Exception:
                logger.warning("Write error for %s/%s", session.session_id, session.tab_id, exc_info=True)
                if session.read_task and not session.read_task.done():
                    session.read_task.cancel()
                break

    async def _check_tmux(self, client: paramiko.SSHClient) -> bool:
        """Silently check if tmux exists on the remote host using a separate channel."""
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(self._ssh_executor, _check_tmux_blocking, client)
        except Exception:
            return False

    async def _destroy_session(self, key: tuple[str, str]) -> None:
        async with self._lock:
            session = self._pop_session_locked(key)
        if session is not None:
            await self._close_session(session)

    def _pop_session_locked(self, key: tuple[str, str]) -> SSHSession | None:
        session = self._sessions.pop(key, None)
        if session is None:
            return None
        # Clean up sid_map references to prevent memory leaks and stale counts
        for sid, keys in list(self._sid_map.items()):
            if key in keys:
                keys.discard(key)
                if not keys:
                    del self._sid_map[sid]
        if session.read_task and not session.read_task.done():
            session.read_task.cancel()
        if session.write_task and not session.write_task.done():
            session.write_task.cancel()
        session.owns_client = not any(other.client is session.client for other in self._sessions.values())
        return session

    async def _close_session(self, session: SSHSession) -> None:
        tasks = [
            task
            for task in (session.read_task, session.write_task)
            if task is not None and not task.done()
        ]
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=1.0,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Timed out waiting for SSH session tasks to stop (%s/%s)",
                    session.session_id,
                    session.tab_id,
                )

        channel = session.channel
        client = session.client if session.owns_client else None
        try:
            _close_ssh_resources(channel, client)
        except Exception:
            pass

    async def _keepalive_loop(self) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            async with self._lock:
                sessions = list(self._sessions.values())
            for session in sessions:
                pass
            loop = asyncio.get_running_loop()
            await asyncio.gather(*(
                loop.run_in_executor(self._ssh_executor, _send_keepalive, session)
                for session in sessions
            ), return_exceptions=True)

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
                sessions = [self._pop_session_locked(key) for key in to_remove]
            for session in sessions:
                if session is not None:
                    await self._close_session(session)
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
    quoted_name = shlex.quote(session_name)
    command = (
        f"tmux has-session -t {quoted_name} 2>/dev/null "
        f"|| tmux new-session -d -s {quoted_name}; "
        f"tmux set-option -t {quoted_name} status off; "
        f"exec tmux attach-session -t {quoted_name}"
    )
    channel.exec_command(command)
    return channel


def _connect_and_check_tmux(
    client: paramiko.SSHClient,
    host: str,
    port: int,
    username: str,
    password: bytearray,
) -> tuple[bool, bool]:
    client.connect(
        hostname=host,
        port=port,
        username=username,
        # Convert only at boundary; caller wipes mutable password immediately
        # after executor returns. Python/Paramiko may still retain transient copies.
        password=bytes(password) if isinstance(password, (bytes, bytearray)) else password,
        timeout=15,
        banner_timeout=15,
        auth_timeout=15,
        look_for_keys=False,
        allow_agent=False,
    )
    try:
        return _connection_probes_blocking(client)
    except Exception:
        return False, False


def _check_tmux_blocking(client: paramiko.SSHClient) -> bool:
    stdin, stdout, stderr = client.exec_command("command -v tmux", timeout=5)
    try:
        out = stdout.read().decode().strip()
        return len(out) > 0
    finally:
        for stream in (stdin, stdout, stderr):
            channel = getattr(stream, "channel", None)
            if channel is not None:
                channel.close()


def _connection_probes_blocking(client: paramiko.SSHClient) -> tuple[bool, bool]:
    command = "if command -v tmux >/dev/null 2>&1; then echo 1; else echo 0; fi; id -u"
    stdin, stdout, stderr = client.exec_command(command, timeout=5)
    try:
        lines = stdout.read().decode(errors="replace").splitlines()
        if len(lines) != 2:
            return False, False
        return lines[0].strip() == "1", lines[1].strip() == "0"
    finally:
        for stream in (stdin, stdout, stderr):
            channel = getattr(stream, "channel", None)
            if channel is not None:
                channel.close()


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
            # Keep latest unmatched exit: it removes every earlier orphaned
            # alt-screen segment from a truncated replay buffer.
            trim_to = pos + length

    return buf[trim_to:] if trim_to else buf


def _room(session_id: str, tab_id: str) -> str:
    return f"session:{session_id}:{tab_id}"


def _send_keepalive(session: SSHSession) -> None:
    try:
        transport = session.channel.get_transport()
        if transport and transport.is_active():
            transport.send_ignore()
    except Exception:
        pass


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


def _blocking_send_all(channel: paramiko.Channel, data: bytes) -> None:
    """Called in thread executor. Blocks until the full input buffer is sent."""
    view = memoryview(data)
    while view:
        if channel.closed:
            raise ConnectionError("Channel closed")
        sent = channel.send(view)
        if sent <= 0:
            raise ConnectionError("Failed to send data to remote host")
        view = view[sent:]


def _close_ssh_resources(channel: paramiko.Channel, client: paramiko.SSHClient | None) -> None:
    try:
        channel.close()
    finally:
        if client is not None:
            client.close()
