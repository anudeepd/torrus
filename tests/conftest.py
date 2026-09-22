"""Shared pytest fixtures for torrus backend tests."""

import os
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
        raise TimeoutError()

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


def _clear_audit_buffers(server_module):
    for buffer in server_module._input_buffers.values():
        close = getattr(buffer, "close", None)
        if close is not None:
            close()
    server_module._input_buffers.clear()
    server_module._sensitive_input_buffers.clear()
    server_module._output_tails.clear()
    server_module._sensitive_prompt_pending.clear()


@pytest.fixture(autouse=True)
def scrub_torrus_environment():
    """No test may leak a TORRUS_*/XDG_* variable into the next one.

    Several call sites assign to ``os.environ`` directly rather than through
    monkeypatch, so isolation needs a snapshot rather than a delete.
    """
    prefixes = ("TORRUS_", "XDG_")
    saved = {k: v for k, v in os.environ.items() if k.startswith(prefixes)}
    for name in [k for k in os.environ if k.startswith(prefixes)]:
        del os.environ[name]
    yield
    for name in [k for k in os.environ if k.startswith(prefixes)]:
        del os.environ[name]
    os.environ.update(saved)


@pytest.fixture(autouse=True)
def reset_server_state():
    """Reset mutable module-level state in server.py before each test."""
    import torrus.server as server_module

    original_ssh_manager = server_module.ssh_manager
    server_module._authenticated_sids.clear()
    server_module._authenticated_users.clear()
    _clear_audit_buffers(server_module)
    server_module._connection_attempts.clear()
    server_module._sid_client_ips.clear()
    server_module._ldap_enabled = False
    server_module._ldap_config = None
    server_module._PENDING_DISABLED_USERS.clear()
    server_module._output_tails.clear()
    server_module._sensitive_prompt_pending.clear()
    yield
    server_module._authenticated_sids.clear()
    server_module._authenticated_users.clear()
    _clear_audit_buffers(server_module)
    server_module._connection_attempts.clear()
    server_module._sid_client_ips.clear()
    server_module._ldap_enabled = False
    server_module._ldap_config = None
    server_module._ldap_session_manager = None
    server_module._PENDING_DISABLED_USERS.clear()
    server_module._output_tails.clear()
    server_module._sensitive_prompt_pending.clear()
    server_module.ssh_manager = original_ssh_manager
