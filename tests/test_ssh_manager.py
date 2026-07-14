"""Tests for torrus.ssh_manager SSH session management."""

import asyncio
import pytest
from unittest.mock import MagicMock, patch


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
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
        from torrus.ssh_manager import SSHManager
        from paramiko import AuthenticationException

        manager = SSHManager(mock_sio)

        with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
            client = MagicMock()
            client.connect = MagicMock(side_effect=AuthenticationException("bad pass"))
            MockClient.return_value = client

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
        import socket

        manager = SSHManager(mock_sio)

        with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
            client = MagicMock()
            client.connect = MagicMock(side_effect=socket.timeout())
            MockClient.return_value = client

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


class TestSessionLifecycle:
    """Session registration, restore, and teardown."""

    @pytest.mark.asyncio
    async def test_unmap_sid_leaves_rooms(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
    async def test_sid_session_count(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
        finally:
            await _cleanup_manager(manager)

    @pytest.mark.asyncio
    async def test_destroy_original_keeps_shared_client_until_clones_close(self, mock_sio, mock_paramiko_client):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        manager.start_background_tasks()
        try:
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
        channel.get_pty.assert_called_once_with(term="xterm-256color", width=120, height=40)
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
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
            with patch("torrus.ssh_manager.paramiko.SSHClient") as MockClient:
                MockClient.return_value = mock_paramiko_client
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
