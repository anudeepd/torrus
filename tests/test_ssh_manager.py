"""Tests for torrus.ssh_manager SSH session management."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


async def _cleanup_manager(manager):
    """Cancel background tasks and destroy all sessions."""
    for task in manager._tasks:
        if not task.done():
            task.cancel()
    for key in list(manager._sessions.keys()):
        await manager._destroy_session(key)
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


class TesTmuxCheck:
    """The tmux probe should not leak channels."""

    @pytest.mark.asyncio
    async def test_check_tmux_closes_channels(self, mock_sio):
        from torrus.ssh_manager import SSHManager

        manager = SSHManager(mock_sio)
        client = MagicMock()
        stdout = MagicMock()
        stdout.read.return_value = b"/usr/bin/tmux"
        stdout.channel.close = MagicMock()
        stderr = MagicMock()
        stderr.channel.close = MagicMock()
        client.exec_command.return_value = (None, stdout, stderr)

        result = await manager._check_tmux(client)
        assert result is True
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
        from torrus.ssh_manager import SSHManager, _blocking_read

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
