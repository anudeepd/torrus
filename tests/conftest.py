"""Shared pytest fixtures for torrus backend tests."""

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
    client = MagicMock()
    transport = MagicMock()
    transport.is_active.return_value = True
    channel = MagicMock()
    channel.closed = False
    channel.get_transport.return_value = transport
    client.get_transport.return_value = transport
    client.invoke_shell.return_value = channel
    return client


@pytest.fixture(autouse=True)
def reset_server_state():
    """Reset mutable module-level state in server.py before each test."""
    import torrus.server as server_module

    server_module._authenticated_sids.clear()
    server_module._ldap_enabled = False
    yield
    server_module._authenticated_sids.clear()
    server_module._ldap_enabled = False
