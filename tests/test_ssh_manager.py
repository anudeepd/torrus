"""Tests for torrus.ssh_manager SSH session management."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


async def _cleanup_manager(manager):
    """Cancel background tasks and destroy all sessions."""
    await manager.stop_background_tasks()
    await asyncio.sleep(0)  # let cancellation propagate


class TestConnectFlow:
    """SSH connection establishment and error handling."""

    @pytest.mark.asyncio
    async def test_connect_success(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                    cols=80,
                    rows=24,
                )

            mock_sio.emit.assert_awaited()
            assert mock_sio.emit.call_args[0][0] == "ssh:connected"
            key = ("sess1", "tab1")
            assert key in manager._sessions
            session = manager._sessions[key]
            assert session.host == "example.com"
            assert session.owns_client is True
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_connect_auth_failure(self, mock_sio):
        from paramiko import AuthenticationException

        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)

        with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
            client = MagicMock()
            client.connect = MagicMock(side_effect=AuthenticationException("bad pass"))
            mock_client.return_value = client

            await manager.connect(
                sid="sid-1",
                session_id="sess1",
                tab_id="tab1",
                host="example.com",
                port=22,
                username="user",
                password="pass",
            )

        mock_sio.emit.assert_awaited_once()
        assert mock_sio.emit.call_args[0][1]["code"] == "auth_failed"
        assert ("sess1", "tab1") not in manager._sessions

    @pytest.mark.asyncio
    async def test_connect_timeout(self, mock_sio):

        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)

        with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
            client = MagicMock()
            client.connect = MagicMock(side_effect=TimeoutError())
            mock_client.return_value = client

            await manager.connect(
                sid="sid-1",
                session_id="sess1",
                tab_id="tab1",
                host="example.com",
                port=22,
                username="user",
                password="pass",
            )

        mock_sio.emit.assert_awaited_once()
        assert mock_sio.emit.call_args[0][1]["code"] == "timeout"

    @pytest.mark.asyncio
    async def test_connect_hard_timeout_covers_blocking_connection_work(self, mock_sio):
        from torrus.ssh_manager import CONNECTION_TIMEOUT, SSHManager

        manager = SSHManager(mock_sio)
        with (
            patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client,
            patch(
                "torrus.ssh_manager.asyncio.wait_for",
                new=AsyncMock(side_effect=TimeoutError()),
            ) as wait_for,
        ):
            client = MagicMock()
            mock_client.return_value = client
            await manager.connect(
                sid="sid-1",
                session_id="sess1",
                tab_id="tab1",
                host="example.com",
                port=22,
                username="user",
                password="pass",
            )

        assert mock_sio.emit.await_args[0][1]["code"] == "timeout"
        assert wait_for.await_args.kwargs["timeout"] == CONNECTION_TIMEOUT
        client.close.assert_called_once()


class TestSessionLifecycle:
    """Session registration, restore, and teardown."""

    @pytest.mark.asyncio
    async def test_unmap_sid_leaves_rooms(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                )

            key = ("sess1", "tab1")
            assert key in manager._sid_map["sid-1"]

            await manager.unmap_sid("sid-1")
            assert "sid-1" not in manager._sid_map
            mock_sio.leave_room.assert_awaited()
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_clone_opens_shared_transport_channel_and_emits_connected(
        self, mock_sio, mock_paramiko_client
    ):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    "sid-1", "sess1", "tab1", "example.com", 22, "user", "pass"
                )
                mock_paramiko_client.invoke_shell = MagicMock(
                    return_value=mock_paramiko_client.invoke_shell()
                )
                await manager.clone("sid-1", "sess1", "tab1", "tab2", 120, 40)

            assert ("sess1", "tab2") in manager._sessions
            assert manager._sessions[("sess1", "tab2")].client is mock_paramiko_client
            mock_paramiko_client.invoke_shell.assert_called_once()
            assert any(
                call.args[0] == "ssh:connected"
                for call in mock_sio.emit.await_args_list
            )
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_clone_rejects_missing_source(self, mock_sio):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        await manager.clone("sid-1", "sess1", "missing", "tab2")
        assert mock_sio.emit.await_args[0][0] == "ssh:error"
        assert mock_sio.emit.await_args[0][1]["code"] == "clone_failed"

    @pytest.mark.asyncio
    async def test_sid_session_count(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="h1",
                    port=22,
                    username="u1",
                    password="p1",
                )
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab2",
                    host="h2",
                    port=22,
                    username="u2",
                    password="p2",
                )

            assert manager.sid_session_count("sid-1") == 2
            assert manager.sid_session_count("sid-unknown") == 0
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_destroy_session_cancels_tasks(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        on_tab_disconnect = AsyncMock()
        manager = SSHManager(mock_sio, on_tab_disconnect=on_tab_disconnect)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                )

            key = ("sess1", "tab1")
            session = manager._sessions[key]
            read_task = session.read_task
            write_task = session.write_task

            await manager._destroy_session(key)
            await asyncio.sleep(0.05)  # let cancellation propagate
            assert read_task.cancelled() or read_task.done()
            assert write_task.cancelled() or write_task.done()
            on_tab_disconnect.assert_awaited_once_with("sess1", "tab1")
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_destroy_original_keeps_shared_client_until_clones_close(
        self, mock_sio, mock_paramiko_client
    ):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                )

            await manager.clone(
                sid="sid-1",
                session_id="sess1",
                source_tab_id="tab1",
                new_tab_id="tab2",
            )

            mock_paramiko_client.close = MagicMock()

            await manager._destroy_session(("sess1", "tab1"))
            assert ("sess1", "tab2") in manager._sessions
            mock_paramiko_client.close.assert_not_called()

            await manager._destroy_session(("sess1", "tab2"))
            mock_paramiko_client.close.assert_called_once()
        finally:
            await _cleanup_manager(manager)


class TestTmuxCheck:
    """The tmux probe should not leak channels."""

    @pytest.mark.asyncio
    async def test_check_tmux_closes_channels(self, mock_sio):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        client = MagicMock()
        stdin = MagicMock()
        stdin.channel.close = MagicMock()
        stdout = MagicMock()
        stdout.read.return_value = b"/usr/bin/tmux"
        stdout.channel.close = MagicMock()
        stderr = MagicMock()
        stderr.channel.close = MagicMock()
        client.exec_command.return_value = (stdin, stdout, stderr)

        result = await manager._check_tmux(client)
        assert result is True
        stdin.channel.close.assert_called_once()
        stdout.channel.close.assert_called_once()
        stderr.channel.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_tmux_returns_false_on_exception(self, mock_sio):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        client = MagicMock()
        client.exec_command.side_effect = OSError("boom")

        result = await manager._check_tmux(client)
        assert result is False


class TestRootCheck:
    def test_connection_probe_checks_root_before_interactive_session(self):
        from torrus.ssh_manager import _connect_and_check_tmux

        client = MagicMock()
        streams = [MagicMock(), MagicMock(), MagicMock()]
        streams[1].read.return_value = b"1\n0\n"
        client.exec_command.return_value = tuple(streams)

        result = _connect_and_check_tmux(client, "example.com", 22, "root", "secret")

        assert result == (True, True)
        client.exec_command.assert_called_once()
        assert "command -v tmux" in client.exec_command.call_args.args[0]
        assert "id -u" in client.exec_command.call_args.args[0]
        for stream in streams:
            stream.channel.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_is_root_session_uses_connection_probe_result(self, mock_sio):
        from torrus.ssh_manager import SSHManager, SSHSession

        manager = SSHManager(mock_sio)
        channel = MagicMock(closed=False)
        client = MagicMock()
        manager._sessions[("sess1", "tab1")] = SSHSession(
            session_id="sess1",
            tab_id="tab1",
            client=client,
            channel=channel,
            host="example.com",
            port=22,
            username="root",
            is_root=True,
        )
        try:
            assert await manager.is_root_session("sess1", "tab1") is True
        finally:
            await manager.stop_background_tasks()

        client.exec_command.assert_not_called()


class TestTmuxChannel:
    def test_open_tmux_channel_hides_status_for_torrus_session(self):
        from torrus.ssh_manager import _open_tmux_channel

        channel = MagicMock()
        transport = MagicMock()
        transport.open_session.return_value = channel
        client = MagicMock()
        client.get_transport.return_value = transport

        result = _open_tmux_channel(client, "sc_test_tab", 120, 40)

        assert result is channel
        channel.get_pty.assert_called_once_with(
            term="xterm-256color", width=120, height=40
        )
        command = channel.exec_command.call_args.args[0]
        assert "tmux set-option -t sc_test_tab status off" in command
        assert command.endswith("exec tmux attach-session -t sc_test_tab")


class TestForceRedraw:
    """force_redraw must be safe against concurrent destruction."""

    @pytest.mark.asyncio
    async def test_force_redraw_under_lock(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                )

            # force_redraw should not raise even during concurrent destruction
            await manager.force_redraw("sess1", "tab1")
            # Now destroy and verify it gracefully handles missing session
            await manager._destroy_session(("sess1", "tab1"))
            await manager.force_redraw("sess1", "tab1")  # should be a no-op
        finally:
            await _cleanup_manager(manager)


class TestReadLoopCleanup:
    """When _read_loop exits, the paired write loop must also be cancelled."""

    @pytest.mark.asyncio
    async def test_read_loop_cancels_write_loop(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as mock_client:
                mock_client.return_value = mock_paramiko_client
                await manager.connect(
                    sid="sid-1",
                    session_id="sess1",
                    tab_id="tab1",
                    host="example.com",
                    port=22,
                    username="user",
                    password="pass",
                )

            key = ("sess1", "tab1")
            session = manager._sessions[key]
            write_task = session.write_task

            # Simulate channel close so _read_loop exits
            session.channel.closed = True
            await asyncio.sleep(0.15)  # give _read_loop time to notice and exit

            assert write_task.cancelled() or write_task.done()
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_idle_cleanup_notifies_tab_disconnect(
        self, mock_sio, mock_paramiko_client
    ):
        from torrus.ssh_manager import SSHManager, SSHSession

        on_tab_disconnect = AsyncMock()
        manager = SSHManager(mock_sio, on_tab_disconnect=on_tab_disconnect)
        session = SSHSession(
            session_id="sess1",
            tab_id="tab1",
            client=mock_paramiko_client,
            channel=MagicMock(closed=True),
            host="example.com",
            port=22,
            username="user",
        )
        manager._sessions[("sess1", "tab1")] = session
        sleep = AsyncMock(side_effect=[None, asyncio.CancelledError()])

        with patch("torrus.ssh_manager.asyncio.sleep", sleep), pytest.raises(asyncio.CancelledError):
            await manager._cleanup_loop()

        on_tab_disconnect.assert_awaited_once_with("sess1", "tab1")
        assert ("sess1", "tab1") not in manager._sessions


class TestOwnerBinding:
    @pytest.mark.asyncio
    async def test_session_target_restore_and_input_reject_foreign_owner(
        self, mock_sio
    ):
        from torrus.ssh_manager import SSHManager, SSHSession

        manager = SSHManager(mock_sio)
        manager.set_sid_owner("sid-bob", "bob")
        session = SSHSession(
            session_id="sess1",
            tab_id="tab1",
            client=MagicMock(),
            channel=MagicMock(closed=False),
            host="example.com",
            port=22,
            username="alice",
            owner_ldap_username="alice",
        )
        manager._sessions[("sess1", "tab1")] = session

        assert await manager.get_session_target("sess1", "tab1", "alice") == (
            "example.com",
            22,
            "alice",
        )
        assert await manager.get_session_target("sess1", "tab1", "bob") is None
        assert await manager.handle_input("sess1", "tab1", "ls", "bob") == "forbidden"
        assert await manager.restore_session("sid-bob", "sess1", "tab1") == "forbidden"
        await manager.stop_background_tasks()


class TestLifecyclePriority:
    @pytest.mark.asyncio
    async def test_interrupt_is_queued_ahead_of_ordinary_input(self, mock_sio):
        from torrus.ssh_manager import SSHManager, SSHSession

        manager = SSHManager(mock_sio)
        session = SSHSession(
            session_id="sess1",
            tab_id="tab1",
            client=MagicMock(),
            channel=MagicMock(closed=False),
            host="example.com",
            port=22,
            username="alice",
            owner_ldap_username="alice",
        )
        manager._sessions[("sess1", "tab1")] = session

        try:
            assert await manager.handle_input("sess1", "tab1", "ordinary") == "queued"
            assert await manager.interrupt("sess1", "tab1") == "queued"
            request = session.control_queue.get_nowait()
            assert request.data == b"\x03"
            assert session.input_queue.get_nowait() == b"ordinary"
        finally:
            await manager.stop_background_tasks()

    @pytest.mark.asyncio
    async def test_large_input_streams_through_bounded_queue(self, mock_sio):
        from torrus.ssh_manager import INPUT_QUEUE_MAX_BYTES, SSHManager, SSHSession

        manager = SSHManager(mock_sio)
        payload = b"x" * (INPUT_QUEUE_MAX_BYTES + 128) + b"\r"
        sent = bytearray()
        sent_event = asyncio.Event()
        channel = MagicMock(closed=False)

        def send(data):
            sent.extend(bytes(data))
            if len(sent) == len(payload):
                sent_event.set()
            return len(data)

        channel.send.side_effect = send
        channel.close.side_effect = lambda: setattr(channel, "closed", True)
        session = SSHSession(
            session_id="sess1",
            tab_id="tab1",
            client=MagicMock(),
            channel=channel,
            host="example.com",
            port=22,
            username="alice",
            owner_ldap_username="alice",
        )
        manager._sessions[("sess1", "tab1")] = session
        session.write_task = asyncio.create_task(manager._write_loop(session))

        try:
            assert await manager.handle_input("sess1", "tab1", payload) == "queued"
            await asyncio.wait_for(sent_event.wait(), timeout=2)
            assert bytes(sent) == payload
        finally:
            await manager.stop_background_tasks()

def test_strict_policy_refuses_an_unknown_host_key(monkeypatch):
    """The default records a new key; `strict` refuses it outright."""
    import paramiko

    from torrus.ssh_manager import HostKeyPolicy

    key = paramiko.RSAKey.generate(1024)
    monkeypatch.setenv("TORRUS_SSH_HOST_KEY_POLICY", "strict")

    with pytest.raises(paramiko.SSHException) as excinfo:
        HostKeyPolicy().missing_host_key(MagicMock(), "example.com", key)

    message = str(excinfo.value)
    assert "Unknown host key" in message
    assert key.fingerprint in message


def test_accept_new_records_the_key_in_the_managed_store(monkeypatch, tmp_path):
    import paramiko

    from torrus.ssh_manager import HostKeyPolicy

    store = tmp_path / "known_hosts"
    monkeypatch.setenv("TORRUS_SSH_HOST_KEY_POLICY", "accept-new")
    monkeypatch.setenv("TORRUS_SSH_KNOWN_HOSTS", str(store))

    key = paramiko.RSAKey.generate(1024)
    client = MagicMock()
    client.get_host_keys.return_value = paramiko.HostKeys()

    HostKeyPolicy().missing_host_key(client, "example.com", key)

    assert client.get_host_keys().get("example.com") is not None
    assert "example.com" in store.read_text()
    assert store.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_a_marker_line_in_the_system_known_hosts_does_not_abort_a_connect(
    monkeypatch, tmp_path
):
    """paramiko raises InvalidHostKey (not OSError) for @cert-authority lines."""
    import paramiko

    from torrus.ssh_manager import SSHManager

    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    (ssh_dir / "known_hosts").write_text(
        "@cert-authority *.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ==\n"
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("TORRUS_SSH_KNOWN_HOSTS", str(tmp_path / "torrus-known_hosts"))

    class Unreachable(paramiko.SSHClient):
        def connect(self, *_args, **_kwargs):
            raise paramiko.SSHException("stubbed transport failure")

    monkeypatch.setattr("torrus.ssh_manager.paramiko.SSHClient", Unreachable)
    sio = MagicMock()
    sio.emit = AsyncMock()
    manager = SSHManager(sio)

    try:
        await manager.connect(
            sid="sid1",
            session_id="sess1",
            tab_id="tab1",
            host="example.com",
            port=22,
            username="user",
            password="pass",
            cols=80,
            rows=24,
        )
    finally:
        await manager.stop_background_tasks()

    # The unreadable line was skipped and the connect failed on its own terms.
    assert sio.emit.await_args.args[0] == "ssh:error"
    assert sio.emit.await_args.args[1]["code"] == "ssh_error"


def test_the_managed_store_tolerates_lines_paramiko_cannot_parse(monkeypatch, tmp_path):
    from torrus.ssh_manager import torrus_host_keys

    store = tmp_path / "known_hosts"
    monkeypatch.setenv("TORRUS_SSH_KNOWN_HOSTS", str(store))

    store.write_text("@cert-authority *.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ==\n")
    assert len(torrus_host_keys()) == 0

    store.write_bytes(b"\xff\xfe not utf-8\n")
    assert len(torrus_host_keys()) == 0


def test_a_closed_send_window_is_retried_instead_of_killing_the_session():
    """settimeout bounds writes too, so a full remote window is not a failure."""
    from torrus.ssh_manager import _blocking_send_all

    class Window:
        def __init__(self) -> None:
            self.closed = False
            self.sent = bytearray()
            self.timeouts = 1

        def send(self, data) -> int:
            if self.timeouts:
                self.timeouts -= 1
                raise TimeoutError()
            self.sent.extend(bytes(data))
            return len(data)

    window = Window()
    _blocking_send_all(window, b"payload")
    assert bytes(window.sent) == b"payload"

    closed = Window()
    closed.closed = True
    with pytest.raises(ConnectionError):
        _blocking_send_all(closed, b"payload")


def _streaming_session(buffered: bytes = b"", offset: int | None = None):
    """A live session whose replay buffer holds ``buffered`` ending at ``offset``."""
    from torrus.ssh_manager import SSHSession

    session = SSHSession(
        session_id="sess1",
        tab_id="tab1",
        client=MagicMock(),
        channel=MagicMock(closed=False),
        host="example.com",
        port=22,
        username="alice",
    )
    session.output_buffer.extend(buffered)
    session.output_offset = len(buffered) if offset is None else offset
    return session


class TestOutputStreamResume:
    """A browser that reconnects gets the bytes it missed, never the buffer twice."""

    @pytest.mark.asyncio
    async def test_each_chunk_is_numbered_by_where_it_ends_in_the_stream(self, mock_sio):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        session = _streaming_session()
        chunks = [b"hello ", b"wor", b"ld"]

        def recv(_size):
            chunk = chunks.pop(0)
            if not chunks:
                session.channel.closed = True
            return chunk

        session.channel.recv.side_effect = recv
        try:
            await manager._read_loop(session)
        finally:
            await manager.stop_background_tasks()

        sent = [
            call.args[1]
            for call in mock_sio.emit.await_args_list
            if call.args[0] == "ssh:output"
        ]
        assert [(p["data"], p["offset"]) for p in sent] == [
            (b"hello ", 6),
            (b"wor", 9),
            (b"ld", 11),
        ]
        assert {p["stream"] for p in sent} == {session.session_instance_id}
        assert session.output_offset == 11
        assert bytes(session.output_buffer) == b"hello world"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("resume_at", "stream_matches", "sent", "reset", "status"),
        [
            # Nothing drawn yet (a fresh page): the whole buffer, as before.
            (None, True, b"abcdef", False, "active"),
            # The buffer covers offsets 94..100. Inside it, only what was missed.
            (97, True, b"def", False, "resumed"),
            (94, True, b"abcdef", False, "resumed"),
            (100, True, None, False, "resumed"),
            # Missed bytes that already fell out of the buffer: rebuild from a reset.
            (93, True, b"abcdef", True, "active"),
            # A position beyond the stream, or from another SSH session, is not ours.
            (101, True, b"abcdef", True, "active"),
            (97, False, b"abcdef", True, "active"),
        ],
    )
    async def test_restore_sends_only_what_the_browser_missed(
        self, mock_sio, resume_at, stream_matches, sent, reset, status
    ):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        session = _streaming_session(b"abcdef", offset=100)
        manager._sessions[("sess1", "tab1")] = session
        resume = None
        if resume_at is not None:
            stream = session.session_instance_id if stream_matches else "another-session"
            resume = (stream, resume_at)

        try:
            result = await manager.restore_session(
                "sid-1", "sess1", "tab1", resume=resume
            )
        finally:
            await manager.stop_background_tasks()

        assert result == status
        mock_sio.enter_room.assert_awaited_once_with("sid-1", "session:sess1:tab1")
        if sent is None:
            mock_sio.emit.assert_not_awaited()
            return
        event, payload = mock_sio.emit.await_args.args
        assert event == "ssh:output"
        assert mock_sio.emit.await_args.kwargs == {"to": "sid-1"}
        assert payload["data"] == sent
        assert payload["offset"] == 100
        assert payload["stream"] == session.session_instance_id
        assert payload.get("reset", False) is reset

    @pytest.mark.asyncio
    async def test_a_chunk_read_while_a_browser_joins_reaches_it_exactly_once(
        self, mock_sio
    ):
        """The join is visible before it returns; without the lock the chunk arrives
        live *and* inside the replay snapshot taken right after."""
        from torrus.ssh_manager import SSHManager

        members: set[str] = set()
        received: list[bytes] = []

        async def enter_room(sid, _room):
            members.add(sid)
            await asyncio.sleep(0.05)

        async def emit(event, payload=None, to=None, room=None):
            delivered_to_new = to == "sid-new" or ("sid-new" in members and room)
            if event == "ssh:output" and delivered_to_new:
                received.append(payload["data"])

        mock_sio.enter_room = AsyncMock(side_effect=enter_room)
        mock_sio.emit = AsyncMock(side_effect=emit)
        manager = SSHManager(mock_sio)
        session = _streaming_session(b"before")
        manager._sessions[("sess1", "tab1")] = session

        def recv(_size):
            session.channel.closed = True
            return b"-live"

        session.channel.recv.side_effect = recv
        try:
            restoring = asyncio.create_task(
                manager.restore_session("sid-new", "sess1", "tab1")
            )
            await asyncio.sleep(0)  # restore is now inside enter_room
            reading = asyncio.create_task(manager._read_loop(session))
            await asyncio.gather(restoring, reading)
        finally:
            await manager.stop_background_tasks()

        assert b"".join(received) == b"before-live"
