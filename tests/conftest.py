"""Shared pytest fixtures for torrus backend tests."""

import socket
import time
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def mock_sio():
    """Return a mocked socketio.AsyncServer."""
    sio = MagicMock()
    sio.emit = AsyncMock()
    sio.enter_room = AsyncMock()
    sio.leave_room = AsyncMock()
    return sio


@pytest.fixture
def mock_ssh_manager(mock_sio):
    """Return an SSHManager instance backed by a mocked socketio server."""
    from torrus.ssh_manager import SSHManager

    return SSHManager(mock_sio)


@pytest.fixture
def mock_paramiko_client():
    """Return a mocked paramiko.SSHClient with a working transport/channel."""
    def quiet_recv(_size):
        time.sleep(0.01)
        raise socket.timeout()

    client = MagicMock()
    client.close = lambda: None
    transport = MagicMock()
    transport.is_active.return_value = True
    channel = MagicMock()
    channel.closed = False

    def close_channel():
        channel.closed = True

    def exec_command(*_args, **_kwargs):
        raise OSError("tmux probe unavailable")

    channel.close = close_channel
    channel.recv.side_effect = quiet_recv
    channel.exit_status_ready.return_value = False
    channel.get_transport.return_value = transport
    client.get_transport.return_value = transport
    client.connect = lambda **_kwargs: None
    client.exec_command = exec_command
    client.invoke_shell = lambda **_kwargs: channel
    return client


@pytest.fixture(autouse=True)
def reset_server_state():
    """Reset mutable module-level state in server.py before each test."""
    import torrus.server as server_module

    server_module._authenticated_sids.clear()
    server_module._authenticated_users.clear()
    server_module._input_buffers.clear()
    server_module._ldap_enabled = False
    server_module._ldap_config = None
    server_module._ldap_session_manager = None
    yield
    server_module._authenticated_sids.clear()
    server_module._authenticated_users.clear()
    server_module._input_buffers.clear()
    server_module._ldap_enabled = False
    server_module._ldap_config = None
    server_module._ldap_session_manager = None
