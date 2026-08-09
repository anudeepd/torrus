"""SSH session manager — owns all paramiko connections."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import shlex
import secrets
import socket
import time
import os
from dataclasses import dataclass, field
from collections.abc import Awaitable, Callable
from typing import Optional

import paramiko

logger = logging.getLogger("torrus.ssh")

OUTPUT_BUFFER_MAX = 10 * 1024  # 10 KB replay buffer per session
IDLE_TIMEOUT = 4 * 3600  # 4 hours
KEEPALIVE_INTERVAL = 30  # seconds
CLEANUP_INTERVAL = 300  # 5 minutes
CHANNEL_READ_TIMEOUT = 0.1  # seconds — blocking read timeout to avoid busy-wait
CONNECTION_TIMEOUT = 20  # seconds — includes DNS and post-login probes
INPUT_QUEUE_MAX_BYTES = 1_048_576
INPUT_CHUNK_BYTES = 32 * 1024
CONTROL_QUEUE_MAX_ITEMS = 32
CONTROL_WRITE_TIMEOUT = 3.0


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
class _ControlRequest:
    data: bytes
    completion: asyncio.Future[str]


@dataclass
class SSHSession:
    session_id: str
    tab_id: str
    client: paramiko.SSHClient
    channel: paramiko.Channel
    host: str
    port: int
    username: str
    owner_ldap_username: str | None = None
    session_instance_id: str = field(default_factory=lambda: secrets.token_urlsafe(18))
    generation: int = 1
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    cols: int = 220
    rows: int = 50
    read_task: Optional[asyncio.Task] = None
    write_task: Optional[asyncio.Task] = None
    input_queue: asyncio.Queue[bytes] = field(
        default_factory=lambda: asyncio.Queue(maxsize=256)
    )
    control_queue: asyncio.Queue[_ControlRequest] = field(
        default_factory=lambda: asyncio.Queue(maxsize=CONTROL_QUEUE_MAX_ITEMS)
    )
    input_queue_bytes: int = 0
    input_available: asyncio.Event = field(default_factory=asyncio.Event)
    input_space_available: asyncio.Event = field(default_factory=asyncio.Event)
    input_closed: asyncio.Event = field(default_factory=asyncio.Event)
    input_submit_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    control_available: asyncio.Event = field(default_factory=asyncio.Event)
    queue_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
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
        on_tab_disconnect: Callable[[str, str], Awaitable[None]] | None = None,
        max_workers: int | None = None,
        on_output: Callable[[str, str, bytes], Awaitable[None]] | None = None,
    ):
        self.sio = sio
        self._on_disconnect = on_disconnect
        self._on_tab_disconnect = on_tab_disconnect
        self._on_output = on_output
        # (session_id, tab_id) -> SSHSession
        self._sessions: dict[tuple[str, str], SSHSession] = {}
        self._generation_counters: dict[tuple[str, str], int] = {}
        # Socket.IO sid -> owner username; used during reconnect restore.
        self._sid_owners: dict[str, str | None] = {}
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
        owner_ldap_username: str | None = None,
    ) -> None:
        password_buffer = (
            password
            if isinstance(password, bytearray)
            else bytearray(password, "utf-8")
        )
        key = (session_id, tab_id)
        room = _room(session_id, tab_id)

        async with self._lock:
            existing = self._sessions.get(key)
            if (
                existing is not None
                and existing.owner_ldap_username != owner_ldap_username
            ):
                logger.warning(
                    "Rejected cross-owner session key reuse for %s/%s",
                    session_id,
                    tab_id,
                )
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Session identity belongs to another user.",
                        "code": "session_owner_mismatch",
                    },
                    to=sid,
                )
                return
            if key in self._pending_keys:
                logger.warning("Connection already in progress for %s", key)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Connection already in progress.",
                        "code": "connect_in_progress",
                    },
                    to=sid,
                )
                return
            self._pending_keys.add(key)
            old_session = self._pop_session_locked(key)
            generation = self._generation_counters.get(key, 0) + 1
            self._generation_counters[key] = generation
        if old_session is not None:
            await self._close_session(old_session)
            await self._notify_tab_disconnect(old_session)

        client: paramiko.SSHClient | None = None
        connection_succeeded = False
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(_WarnThenAddPolicy())

            loop = asyncio.get_running_loop()
            target = f"{username}@{host}:{port}"
            logger.info(
                "Connecting to %s (session=%s, tab=%s)", target, session_id, tab_id
            )

            try:
                has_tmux, is_root = await asyncio.wait_for(
                    loop.run_in_executor(
                        self._ssh_executor,
                        lambda: _connect_and_check_tmux(
                            client, host, port, username, password_buffer
                        ),
                    ),
                    timeout=CONNECTION_TIMEOUT,
                )
            except paramiko.AuthenticationException:
                logger.warning("Auth failed for %s", target)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Authentication failed. Check username and password.",
                        "code": "auth_failed",
                    },
                    to=sid,
                )
                return
            except paramiko.SSHException:
                logger.warning("SSH error for %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "SSH connection failed.",
                        "code": "ssh_error",
                    },
                    to=sid,
                )
                return
            except (socket.timeout, TimeoutError):
                logger.warning("Connection to %s timed out", target)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Connection timed out after 15 seconds.",
                        "code": "timeout",
                    },
                    to=sid,
                )
                return
            except OSError:
                logger.warning("Cannot reach %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Cannot reach host.",
                        "code": "host_unreachable",
                    },
                    to=sid,
                )
                return

            tmux_name = (
                f"sc_{session_id.replace('-', '')}_{tab_id}" if has_tmux else None
            )

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
                        environment={
                            "COLORTERM": "truecolor",
                            "TERM": "xterm-256color",
                        },
                    )
            except Exception:
                logger.warning("Failed to open shell for %s", target, exc_info=True)
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": tab_id,
                        "message": "Failed to open remote shell.",
                        "code": "shell_error",
                    },
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
                owner_ldap_username=owner_ldap_username,
                generation=generation,
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
                {
                    "tab_id": tab_id,
                    "session_instance_id": session.session_instance_id,
                    "generation": session.generation,
                    "message": f"Connected to {username}@{host}",
                },
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

    async def restore_session(
        self,
        sid: str,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> str:
        """Re-attach only when the authenticated owner matches the session."""
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
            if session is None or session.channel.closed:
                return "dead"
            effective_owner = (
                owner_ldap_username
                if owner_ldap_username is not None
                else self._sid_owners.get(sid)
            )
            if (
                effective_owner is not None
                and session.owner_ldap_username != effective_owner
            ):
                return "forbidden"
            self._sid_map.setdefault(sid, set()).add(key)

        room = _room(session_id, tab_id)
        await self.sio.enter_room(sid, room)

        if session.output_buffer:
            replay = _sanitize_replay_buffer(bytes(session.output_buffer))
            if replay:
                await self.sio.emit(
                    "ssh:output",
                    {"tab_id": tab_id, "data": replay},
                    to=sid,
                )

        return "active"

    async def force_redraw(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> None:
        """Toggle PTY size to send SIGWINCH, scoped to the authenticated owner."""
        key = (session_id, tab_id)
        loop = asyncio.get_running_loop()
        async with self._lock:
            session = self._sessions.get(key)
            if (
                session is None
                or session.channel.closed
                or (
                    owner_ldap_username is not None
                    and session.owner_ldap_username != owner_ldap_username
                )
            ):
                return
            try:
                await loop.run_in_executor(
                    self._ssh_executor,
                    session.channel.resize_pty,
                    session.cols + 1,
                    session.rows,
                )
                await loop.run_in_executor(
                    self._ssh_executor,
                    session.channel.resize_pty,
                    session.cols,
                    session.rows,
                )
            except Exception:
                logger.warning(
                    "force_redraw failed for %s/%s", session_id, tab_id, exc_info=True
                )

    async def handle_input(
        self,
        session_id: str,
        tab_id: str,
        data: str | bytes,
        owner_ldap_username: str | None = None,
        on_input_accepted: Callable[[bytes], Awaitable[None]] | None = None,
    ) -> str:
        """Queue input in bounded chunks while preserving submission order."""
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed or session.input_closed.is_set():
            return "unknown"
        if (
            owner_ldap_username is not None
            and session.owner_ldap_username != owner_ldap_username
        ):
            return "forbidden"

        if isinstance(data, str):
            data = data.encode("utf-8", errors="replace")
        if not data:
            return "sent"

        async with session.input_submit_lock:
            offset = 0
            while offset < len(data):
                accepted_chunk: bytes | None = None
                async with session.queue_lock:
                    if session.channel.closed or session.input_closed.is_set():
                        return "unknown"
                    capacity = INPUT_QUEUE_MAX_BYTES - session.input_queue_bytes
                    if capacity > 0:
                        chunk_size = min(
                            INPUT_CHUNK_BYTES, capacity, len(data) - offset
                        )
                        accepted_chunk = data[offset : offset + chunk_size]
                        try:
                            session.input_queue.put_nowait(accepted_chunk)
                        except asyncio.QueueFull:
                            accepted_chunk = None
                            capacity = 0
                        else:
                            session.input_queue_bytes += chunk_size
                            offset += chunk_size
                            session.input_available.set()
                            if session.input_queue_bytes >= INPUT_QUEUE_MAX_BYTES:
                                session.input_space_available.clear()
                            else:
                                session.input_space_available.set()
                if accepted_chunk is not None:
                    if on_input_accepted is not None:
                        await on_input_accepted(accepted_chunk)
                    continue
                space_wait = asyncio.create_task(session.input_space_available.wait())
                closed_wait = asyncio.create_task(session.input_closed.wait())
                try:
                    done, _pending = await asyncio.wait(
                        (space_wait, closed_wait),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    for wait_task in (space_wait, closed_wait):
                        if not wait_task.done():
                            wait_task.cancel()
                    await asyncio.gather(
                        space_wait, closed_wait, return_exceptions=True
                    )
                if closed_wait in done or session.input_closed.is_set():
                    return "unknown"
        session.last_activity = time.time()
        return "queued"

    async def interrupt(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> str:
        """Queue Ctrl+C ahead of ordinary input and report delivery truthfully."""
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return "unknown"
        if (
            owner_ldap_username is not None
            and session.owner_ldap_username != owner_ldap_username
        ):
            return "forbidden"

        loop = asyncio.get_running_loop()
        completion: asyncio.Future[str] = loop.create_future()
        request = _ControlRequest(b"\x03", completion)
        async with session.queue_lock:
            try:
                session.control_queue.put_nowait(request)
                session.control_available.set()
            except asyncio.QueueFull:
                return "unknown"
        try:
            return await asyncio.wait_for(
                asyncio.shield(completion), timeout=CONTROL_WRITE_TIMEOUT
            )
        except asyncio.TimeoutError:
            return "queued"

    async def get_session_target(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> tuple[str, int, str] | None:
        """Return the active SSH target for audit attribution."""
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return None
            if (
                owner_ldap_username is not None
                and session.owner_ldap_username != owner_ldap_username
            ):
                return None
            return session.host, session.port, session.username

    async def get_session_identity(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> dict[str, str | int | float] | None:
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return None
            if (
                owner_ldap_username is not None
                and session.owner_ldap_username != owner_ldap_username
            ):
                return None
            return {
                "session_id": session.session_id,
                "tab_id": session.tab_id,
                "session_instance_id": session.session_instance_id,
                "generation": session.generation,
                "owner_ldap_username": session.owner_ldap_username or "",
                "host": session.host,
                "port": session.port,
                "username": session.username,
                "created_at": session.created_at,
                "last_activity": session.last_activity,
            }

    async def is_root_session(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> bool:
        """Return whether the active SSH session has effective UID zero."""
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if session is None or session.channel.closed:
                return False
            if (
                owner_ldap_username is not None
                and session.owner_ldap_username != owner_ldap_username
            ):
                return False
            return session.is_root

    async def has_session(
        self, session_id: str, owner_ldap_username: str | None = None
    ) -> bool:
        """Return True when any active tab exists for this owner/session ID."""
        async with self._lock:
            return any(
                key_session_id == session_id
                and (
                    owner_ldap_username is None
                    or session.owner_ldap_username == owner_ldap_username
                )
                for (key_session_id, _tab_id), session in self._sessions.items()
            )

    async def list_sessions(self) -> list[dict[str, str | int | float]]:
        async with self._lock:
            sessions = [
                session
                for session in self._sessions.values()
                if not session.channel.closed
            ]
            return [
                {
                    "session_id": session.session_id,
                    "tab_id": session.tab_id,
                    "session_instance_id": session.session_instance_id,
                    "generation": session.generation,
                    "owner_ldap_username": session.owner_ldap_username or "",
                    "host": session.host,
                    "port": session.port,
                    "username": session.username,
                    "created_at": session.created_at,
                    "last_activity": session.last_activity,
                }
                for session in sessions
            ]

    async def interrupt_session(self, session_instance_id: str, generation: int) -> str:
        async with self._lock:
            session = next(
                (
                    value
                    for value in self._sessions.values()
                    if value.session_instance_id == session_instance_id
                    and value.generation == generation
                    and not value.channel.closed
                ),
                None,
            )
        if session is None:
            return "unknown"
        return await self.interrupt(session.session_id, session.tab_id)

    async def terminate_session(self, session_instance_id: str, generation: int) -> str:
        async with self._lock:
            session = next(
                (
                    value
                    for value in self._sessions.values()
                    if value.session_instance_id == session_instance_id
                    and value.generation == generation
                    and not value.channel.closed
                ),
                None,
            )
        if session is None:
            return "unknown"
        await self.sio.emit(
            "ssh:closed",
            {
                "tab_id": session.tab_id,
                "reason": "Session terminated by administrator.",
            },
            room=_room(session.session_id, session.tab_id),
        )
        return (
            "closed"
            if await self._destroy_session((session.session_id, session.tab_id))
            else "unknown"
        )

    async def terminate_owner_sessions(self, owner_ldap_username: str) -> int:
        """Close every live tab owned by an LDAP identity."""
        target_owner = owner_ldap_username.casefold()
        async with self._lock:
            identities = [
                (session.session_instance_id, session.generation)
                for session in self._sessions.values()
                if session.owner_ldap_username is not None
                and session.owner_ldap_username.casefold() == target_owner
                and not session.channel.closed
            ]
        closed = 0
        for session_instance_id, generation in identities:
            if (
                await self.terminate_session(session_instance_id, generation)
                == "closed"
            ):
                closed += 1
        return closed

    async def open_sftp_channel(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ):
        """Open SFTP only on an SSH transport owned by the caller."""
        loop = asyncio.get_running_loop()
        async with self._lock:
            session = self._sessions.get((session_id, tab_id))
            if (
                session is None
                or session.channel.closed
                or (
                    owner_ldap_username is not None
                    and session.owner_ldap_username != owner_ldap_username
                )
            ):
                return None
            transport = session.client.get_transport()
            if transport is None or not transport.is_active():
                return None
            try:
                return await loop.run_in_executor(
                    self._ssh_executor, transport.open_sftp_client
                )
            except AttributeError:
                return await loop.run_in_executor(
                    self._ssh_executor, session.client.open_sftp
                )
            except Exception:
                logger.warning(
                    "Failed to open SFTP channel for %s/%s",
                    session_id,
                    tab_id,
                    exc_info=True,
                )
                return None

    async def handle_resize(
        self,
        session_id: str,
        tab_id: str,
        cols: int,
        rows: int,
        owner_ldap_username: str | None = None,
    ) -> None:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
        if session is None or session.channel.closed:
            return
        if (
            owner_ldap_username is not None
            and session.owner_ldap_username != owner_ldap_username
        ):
            return

        session.cols = cols
        session.rows = rows
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                self._ssh_executor, session.channel.resize_pty, cols, rows
            )
        except Exception:
            pass

    async def disconnect_session(
        self,
        session_id: str,
        tab_id: str,
        owner_ldap_username: str | None = None,
    ) -> str:
        key = (session_id, tab_id)
        async with self._lock:
            session = self._sessions.get(key)
            if session is not None and (
                owner_ldap_username is not None
                and session.owner_ldap_username != owner_ldap_username
            ):
                return "forbidden"
        if session:
            logger.info(
                "Disconnecting %s@%s (tab=%s)", session.username, session.host, tab_id
            )
        return "closed" if await self._destroy_session(key) else "unknown"

    async def clone(
        self,
        sid: str,
        session_id: str,
        source_tab_id: str,
        new_tab_id: str,
        cols: int = 220,
        rows: int = 50,
        owner_ldap_username: str | None = None,
    ) -> None:
        """Clone only from a session owned by the authenticated user."""
        source_key = (session_id, source_tab_id)
        new_key = (session_id, new_tab_id)
        room = _room(session_id, new_tab_id)
        replaced_session: SSHSession | None = None

        async with self._lock:
            source = self._sessions.get(source_key)
            if (
                source is None
                or source.channel.closed
                or (
                    owner_ldap_username is not None
                    and source.owner_ldap_username != owner_ldap_username
                )
            ):
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": new_tab_id,
                        "message": "Source session is no longer active.",
                        "code": "clone_failed",
                    },
                    to=sid,
                )
                return
            existing = self._sessions.get(new_key)
            if existing is not None:
                if (
                    owner_ldap_username is not None
                    and existing.owner_ldap_username != owner_ldap_username
                ):
                    await self.sio.emit(
                        "ssh:error",
                        {
                            "tab_id": new_tab_id,
                            "message": "Session identity belongs to another user.",
                            "code": "session_owner_mismatch",
                        },
                        to=sid,
                    )
                    return
                await self._close_session(existing)
                self._sessions.pop(new_key, None)
                replaced_session = existing

            generation = self._generation_counters.get(new_key, 0) + 1
            self._generation_counters[new_key] = generation
            source_username = source.username
            source_host = source.host
            loop = asyncio.get_running_loop()
            try:
                channel = await loop.run_in_executor(
                    self._ssh_executor,
                    lambda: source.client.invoke_shell(
                        term="xterm-256color",
                        width=cols,
                        height=rows,
                        environment={
                            "COLORTERM": "truecolor",
                            "TERM": "xterm-256color",
                        },
                    ),
                )
            except Exception:
                logger.warning(
                    "Failed to clone session for %s", source_key, exc_info=True
                )
                await self.sio.emit(
                    "ssh:error",
                    {
                        "tab_id": new_tab_id,
                        "message": "Failed to clone session.",
                        "code": "clone_failed",
                    },
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
                owner_ldap_username=source.owner_ldap_username,
                generation=generation,
                is_root=source.is_root,
                cols=cols,
                rows=rows,
                owns_client=False,
            )
            self._sessions[new_key] = session
            self._sid_map.setdefault(sid, set()).add(new_key)

        if replaced_session is not None:
            await self._notify_tab_disconnect(replaced_session)
        await self.sio.enter_room(sid, room)
        session.read_task = asyncio.create_task(self._read_loop(session))
        session.write_task = asyncio.create_task(self._write_loop(session))

        logger.info(
            "Cloned session %s@%s (tab=%s → %s)",
            source_username,
            source_host,
            source_tab_id,
            new_tab_id,
        )

        await self.sio.emit(
            "ssh:connected",
            {
                "tab_id": new_tab_id,
                "session_instance_id": session.session_instance_id,
                "generation": session.generation,
                "message": f"Cloned from {source_username}@{source_host}",
            },
            to=sid,
        )

    def set_sid_owner(self, sid: str, owner_ldap_username: str | None) -> None:
        self._sid_owners[sid] = owner_ldap_username

    def sid_session_count(self, sid: str) -> int:
        """Return the number of active SSH sessions owned by a socket id."""
        return len(self._sid_map.get(sid, set()))

    async def unmap_sid(self, sid: str) -> None:
        """Called on socket disconnect — does NOT destroy the SSH session."""
        self._sid_owners.pop(sid, None)
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
        reason = "Connection closed by remote host."

        while not session.channel.closed:
            try:
                data = await loop.run_in_executor(
                    self._ssh_executor, _blocking_read, session.channel
                )
            except asyncio.CancelledError:
                return
            except Exception:
                logger.warning(
                    "Read error for %s/%s",
                    session.session_id,
                    session.tab_id,
                    exc_info=True,
                )
                reason = "Connection closed."
                break

            if data:
                session.last_activity = time.time()
                session.output_buffer.extend(data)
                if len(session.output_buffer) > OUTPUT_BUFFER_MAX:
                    del session.output_buffer[
                        : len(session.output_buffer) - OUTPUT_BUFFER_MAX
                    ]
                if self._on_output is not None:
                    try:
                        await self._on_output(
                            session.session_id, session.tab_id, bytes(data)
                        )
                    except Exception:
                        logger.exception(
                            "Output callback failed for %s/%s",
                            session.session_id,
                            session.tab_id,
                        )
                await self.sio.emit(
                    "ssh:output",
                    {"tab_id": session.tab_id, "data": data},
                    room=room,
                )
        session.input_closed.set()
        session.input_space_available.set()

        await self.sio.emit(
            "ssh:closed",
            {"tab_id": session.tab_id, "reason": reason},
            room=room,
        )
        async with self._lock:
            current = self._sessions.get((session.session_id, session.tab_id))
            if current is not session:
                return
            removed = self._pop_session_locked(
                (session.session_id, session.tab_id), cancel_current=False
            )
            still_connected = any(
                key[0] == session.session_id for key in self._sessions
            )
        if removed is not None:
            _close_ssh_resources(
                removed.channel,
                removed.client if removed.owns_client else None,
            )
        await self._notify_tab_disconnect(session)
        if not still_connected and self._on_disconnect is not None:
            await self._on_disconnect(session.session_id)

    async def _write_loop(self, session: SSHSession) -> None:
        """Serialize input while giving control traffic strict priority."""
        loop = asyncio.get_running_loop()

        while not session.channel.closed:
            request: _ControlRequest | None = None
            data: bytes | None = None
            async with session.queue_lock:
                try:
                    request = session.control_queue.get_nowait()
                    if session.control_queue.empty():
                        session.control_available.clear()
                except asyncio.QueueEmpty:
                    try:
                        data = session.input_queue.get_nowait()
                        session.input_queue_bytes -= len(data)
                        session.input_space_available.set()
                        if session.input_queue.empty():
                            session.input_available.clear()
                    except asyncio.QueueEmpty:
                        session.control_available.clear()
                        session.input_available.clear()

            if request is None and data is None:
                control_wait = asyncio.create_task(session.control_available.wait())
                input_wait = asyncio.create_task(session.input_available.wait())
                try:
                    await asyncio.wait(
                        (control_wait, input_wait),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    for wait_task in (control_wait, input_wait):
                        if not wait_task.done():
                            wait_task.cancel()
                    await asyncio.gather(
                        control_wait, input_wait, return_exceptions=True
                    )
                continue

            payload = request.data if request is not None else data
            try:
                await loop.run_in_executor(
                    self._ssh_executor, _blocking_send_all, session.channel, payload
                )
                session.last_activity = time.time()
                if request is not None and not request.completion.done():
                    request.completion.set_result("sent")
            except asyncio.CancelledError:
                if request is not None and not request.completion.done():
                    request.completion.set_result("failed")
                return
            except Exception:
                logger.warning(
                    "Write error for %s/%s",
                    session.session_id,
                    session.tab_id,
                    exc_info=True,
                )
                if request is not None and not request.completion.done():
                    request.completion.set_result("failed")
                if session.read_task and not session.read_task.done():
                    session.read_task.cancel()
                return

    async def _check_tmux(self, client: paramiko.SSHClient) -> bool:
        """Silently check if tmux exists on the remote host using a separate channel."""
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                self._ssh_executor, _check_tmux_blocking, client
            )
        except Exception:
            return False

    async def _destroy_session(self, key: tuple[str, str]) -> bool:
        async with self._lock:
            session = self._pop_session_locked(key)
        if session is None:
            return False
        await self._close_session(session)
        await self._notify_tab_disconnect(session)
        return True

    async def _notify_tab_disconnect(self, session: SSHSession) -> None:
        if self._on_tab_disconnect is None:
            return
        try:
            await self._on_tab_disconnect(session.session_id, session.tab_id)
        except Exception:
            logger.warning(
                "Per-tab disconnect callback failed for %s/%s",
                session.session_id,
                session.tab_id,
                exc_info=True,
            )

    def _pop_session_locked(
        self, key: tuple[str, str], cancel_current: bool = True
    ) -> SSHSession | None:
        session = self._sessions.pop(key, None)
        if session is None:
            return None
        for sid, keys in list(self._sid_map.items()):
            if key in keys:
                keys.discard(key)
                if not keys:
                    del self._sid_map[sid]
        current_task = asyncio.current_task()
        if (
            cancel_current
            and session.read_task
            and not session.read_task.done()
            and session.read_task is not current_task
        ):
            session.read_task.cancel()
        if (
            cancel_current
            and session.write_task
            and not session.write_task.done()
            and session.write_task is not current_task
        ):
            session.write_task.cancel()
        session.owns_client = not any(
            other.client is session.client for other in self._sessions.values()
        )
        return session

    async def _close_session(self, session: SSHSession) -> None:
        session.input_closed.set()
        session.input_space_available.set()
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
            await asyncio.gather(
                *(
                    loop.run_in_executor(self._ssh_executor, _send_keepalive, session)
                    for session in sessions
                ),
                return_exceptions=True,
            )

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL)
            now = time.time()
            async with self._lock:
                to_remove = [
                    key
                    for key, session in self._sessions.items()
                    if session.channel.closed
                    or (now - session.last_activity) > IDLE_TIMEOUT
                ]
                sessions = [self._pop_session_locked(key) for key in to_remove]
            for session in sessions:
                if session is None:
                    continue
                await self._close_session(session)
                await self._notify_tab_disconnect(session)


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
        password=bytes(password)
        if isinstance(password, (bytes, bytearray))
        else password,
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
    ENTERS = (b"\x1b[?1049h", b"\x1b[?47h", b"\x1b[?1047h")
    EXITS = (b"\x1b[?1049l", b"\x1b[?47l", b"\x1b[?1047l")

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


def _close_ssh_resources(
    channel: paramiko.Channel, client: paramiko.SSHClient | None
) -> None:
    try:
        channel.close()
    finally:
        if client is not None:
            client.close()
