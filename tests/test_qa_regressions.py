"""Regression tests for findings from the four-commit QA review."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_large_input_is_queued_without_partial_timeout(mock_sio):
    from torrus.ssh_manager import INPUT_QUEUE_MAX_BYTES, SSHManager, SSHSession

    manager = SSHManager(mock_sio)
    payload = b"x" * (INPUT_QUEUE_MAX_BYTES + 128)
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
        session_id="sess",
        tab_id="tab",
        client=MagicMock(),
        channel=channel,
        host="example.com",
        port=22,
        username="root",
    )
    manager._sessions[("sess", "tab")] = session
    session.write_task = asyncio.create_task(manager._write_loop(session))

    try:
        assert await manager.handle_input("sess", "tab", payload) == "queued"
        await asyncio.wait_for(sent_event.wait(), timeout=2)
        assert bytes(sent) == payload
    finally:
        await manager.stop_background_tasks()


def test_unterminated_audit_input_is_bounded():
    import torrus.server as server_module

    buffer = server_module._CommandInputBuffer()
    try:
        buffer.extract(b"x" * (server_module._INPUT_BUFFER_MAX_BYTES + 1))
        assert buffer.size == server_module._INPUT_BUFFER_MAX_BYTES
        assert buffer.overflowed is True
        assert buffer.extract(b"\r") == [server_module._OVERSIZED_INPUT_MARKER]
        assert buffer.size == 0
    finally:
        buffer.close()


@pytest.mark.asyncio
async def test_remote_ssh_close_cleans_tab_audit_buffer(mock_sio):
    from torrus.ssh_manager import SSHManager, SSHSession

    on_tab_disconnect = AsyncMock()
    manager = SSHManager(mock_sio, on_tab_disconnect=on_tab_disconnect)
    channel = MagicMock(closed=True)
    session = SSHSession(
        session_id="sess",
        tab_id="tab",
        client=MagicMock(),
        channel=channel,
        host="example.com",
        port=22,
        username="root",
    )
    manager._sessions[("sess", "tab")] = session

    await manager._read_loop(session)

    on_tab_disconnect.assert_awaited_once_with("sess", "tab")
    assert ("sess", "tab") not in manager._sessions
    await manager.stop_background_tasks()


def test_pending_disable_survives_unrelated_allowlist_update(monkeypatch):
    import torrus.server as server_module

    ldap_settings = SimpleNamespace(allowed_users=["alice", "bob"])
    monkeypatch.setattr(
        server_module, "_ldap_config", SimpleNamespace(ldap=ldap_settings)
    )
    server_module._PENDING_DISABLED_USERS.add("bob")

    server_module._apply_live_ldap_allowlist(["alice", "carol"])

    assert ldap_settings.allowed_users == ["alice", "carol", "bob"]


@pytest.mark.asyncio
async def test_rejected_input_still_gets_audit_record(monkeypatch):
    import torrus.server as server_module

    server_module._ldap_enabled = True
    server_module._authenticated_sids.add("sid")
    server_module._authenticated_users["sid"] = "alice"
    server_module._ldap_session_manager = MagicMock()
    server_module._ldap_session_manager.verify_session.return_value = "alice"

    async def reject_with_audit(*_args, **kwargs):
        await kwargs["on_input_accepted"](b"echo hi\r")
        return "unknown"

    with (
        patch.object(
            server_module,
            "_require_auth",
            AsyncMock(return_value=True),
        ),
        patch.object(
            server_module.ssh_manager,
            "get_session_target",
            AsyncMock(return_value=("example.com", 22, "root")),
        ),
        patch.object(
            server_module.ssh_manager,
            "handle_input",
            AsyncMock(side_effect=reject_with_audit),
        ),
        patch.object(
            server_module.audit_store,
            "record_command_event",
            AsyncMock(),
        ) as record,
    ):
        result = await server_module.on_ssh_input(
            "sid",
            {"session_id": "sess", "tab_id": "tab", "data": "echo hi\r"},
        )

    assert result == {
        "ok": False,
        "status": "unknown",
        "code": "unknown",
        "error": "Input was not accepted.",
    }
    record.assert_awaited_once()


@pytest.mark.asyncio
async def test_activity_username_filter_is_case_insensitive(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_command_event(
        ldap_username="Alice",
        session_id="sess",
        tab_id="tab",
        command="id",
        ssh_host="example.com",
        ssh_port=22,
        ssh_username="root",
    )

    assert len(audit_store.list_terminal_input_events(username="alice")) == 1
    assert len(audit_store.list_terminal_input_events(username="ALICE")) == 1
