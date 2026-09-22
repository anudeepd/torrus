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
            # The writer is synchronous now and runs in a worker thread.
            "record_command_event",
            MagicMock(),
        ) as record,
    ):
        result = await server_module.on_ssh_input(
            "sid",
            {"session_id": "sess", "tab_id": "tab", "data": "echo hi\r"},
        )

    assert result == {
        "ok": False,
        "code": "session_not_found",
        "message": "Input was not accepted.",
    }
    record.assert_called_once()


@pytest.mark.asyncio
async def test_activity_username_filter_is_case_insensitive(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    audit_store.record_command_event(
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


@pytest.mark.asyncio
async def test_sftp_inline_download_records_audit(mock_sio, monkeypatch):
    """sftp:download must persist one audit row with path and size."""
    import torrus.server as server_module

    async def fake_owner(_sid):
        return "alice"

    async def fake_download(tab_id, path, max_bytes=None):
        return {
            "ok": True,
            "path": "/home/app/readme.txt",
            "name": "readme.txt",
            "size": 5,
            "data": "aGVsbG8=",
        }

    async def fake_target(_tab_id):
        return ("ssh.example.com", 22, "root")

    monkeypatch.setattr(server_module, "_ldap_enabled", True)
    monkeypatch.setattr(server_module, "_owner_for_sid", fake_owner)
    monkeypatch.setattr(server_module, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server_module,
        "_require_sftp_session_owner",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(server_module.sftp_manager, "download_file", fake_download)
    monkeypatch.setattr(server_module.sftp_manager, "session_target", fake_target)
    with patch.object(
        server_module.audit_store, "record_sftp_event", MagicMock()
    ) as record:
        await server_module.on_sftp_download(
            "sid", {"session_id": "s", "tab_id": "t", "path": "readme.txt"}
        )

    assert record.call_count == 1
    kwargs = record.call_args.kwargs
    assert kwargs["ldap_username"] == "alice"
    assert kwargs["operation"] == "download"
    assert kwargs["path"] == "/home/app/readme.txt"


@pytest.mark.asyncio
async def test_sftp_rename_records_audit_with_target(mock_sio, monkeypatch):
    """sftp:rename must persist old path with the new path as detail."""
    import torrus.server as server_module

    async def fake_owner(_sid):
        return "alice"

    async def fake_rename(tab_id, old_path, new_path):
        return {
            "ok": True,
            "old_path": "/home/app/a.txt",
            "new_path": "/home/app/b.txt",
        }

    async def fake_target(_tab_id):
        return ("ssh.example.com", 22, "root")

    monkeypatch.setattr(server_module, "_ldap_enabled", True)
    monkeypatch.setattr(server_module, "_owner_for_sid", fake_owner)
    monkeypatch.setattr(server_module, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server_module,
        "_require_sftp_session_owner",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(server_module.sftp_manager, "rename", fake_rename)
    monkeypatch.setattr(server_module.sftp_manager, "session_target", fake_target)
    with patch.object(
        server_module.audit_store, "record_sftp_event", MagicMock()
    ) as record:
        await server_module.on_sftp_rename(
            "sid",
            {
                "session_id": "s",
                "tab_id": "t",
                "old_path": "a.txt",
                "new_path": "b.txt",
            },
        )

    assert record.call_count == 1
    kwargs = record.call_args.kwargs
    assert kwargs["operation"] == "rename"
    assert kwargs["path"] == "/home/app/a.txt"
    assert kwargs["detail"] == "-> /home/app/b.txt"

@pytest.mark.asyncio
async def test_sftp_lock_is_released_when_its_tab_closes():
    """The per-tab lock map must not keep one entry per tab ever opened."""
    from torrus.sftp_manager import SFTPManager

    manager = SFTPManager()
    manager._sessions["tab1"] = SimpleNamespace(
        session_id="sess1", tab_id="tab1", client=MagicMock(), cwd="/home/app"
    )
    manager._locks["tab1"] = asyncio.Lock()

    await manager.close_sftp("tab1")

    assert "tab1" not in manager._locks


@pytest.mark.asyncio
async def test_ssh_generation_keeps_rising_across_reconnects(mock_sio, mock_paramiko_client):
    """Generation must stay strictly monotonic, so a stale target can never match."""
    from torrus.ssh_manager import SSHManager

    manager = SSHManager(mock_sio)
    with patch("torrus.ssh_manager.paramiko.SSHClient") as ssh_client:
        ssh_client.return_value = mock_paramiko_client
        await manager.connect(
            sid="sid-1", session_id="sess1", tab_id="tab1", host="example.com",
            port=22, username="user", password="pass", cols=80, rows=24,
        )
        first = manager._sessions[("sess1", "tab1")].generation
        await manager.connect(
            sid="sid-1", session_id="sess1", tab_id="tab1", host="example.com",
            port=22, username="user", password="pass", cols=80, rows=24,
        )
        second = manager._sessions[("sess1", "tab1")].generation
        await manager.stop_background_tasks()

    assert second > first

@pytest.mark.asyncio
async def test_ssh_connect_refuses_a_non_string_password(monkeypatch):
    """bytearray(None) raises and bytearray(5) silently becomes five NUL bytes."""
    import torrus.server as server_module
    from torrus.server import on_ssh_connect

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    connect = AsyncMock()
    monkeypatch.setattr(server_module, "_ldap_enabled", False)
    monkeypatch.setattr(server_module.ssh_manager, "connect", connect)
    monkeypatch.setattr(server_module, "sio", sio_mock)

    await on_ssh_connect(
        "sid-1",
        {
            "host": "example.com",
            "port": 22,
            "username": "user",
            "password": None,
            "session_id": "sess1",
            "tab_id": "tab1",
        },
    )

    connect.assert_not_called()
    assert sio_mock.emit.call_args[0][1]["code"] == "invalid_request"


@pytest.mark.asyncio
async def test_upload_store_eviction_aborts_after_releasing_the_lock():
    """Eviction must not hold the store lock across a remote sink abort."""
    from torrus.upload_engine import UploadStore

    aborted_under_lock: list[bool] = []
    store = UploadStore(max_sessions=1, max_sessions_per_user=5)
    target = SimpleNamespace(
        session_id="s1", user="alice", directory="/tmp", filename="a.bin", size=0, extra={}
    )

    class Sink:
        async def abort(self) -> None:
            aborted_under_lock.append(store._lock.locked())

    first = await store.register(target, user="alice")
    first.sink = Sink()

    # Registering past max_sessions evicts the first session.
    await store.register(target, user="alice")

    assert aborted_under_lock == [False]

@pytest.mark.asyncio
async def test_server_redacts_input_after_a_prompt_the_client_did_not_flag(monkeypatch):
    """Redaction must not depend on the audited client marking its own input."""
    import torrus.server as server_module
    from torrus.server import _note_output_for_redaction, _record_ssh_input_audit

    key = ("sid", "sess", "tab")
    server_module._output_tails[key] = ""
    _note_output_for_redaction(key, b"root@db01's password:")
    assert key in server_module._sensitive_prompt_pending

    recorded = MagicMock()
    monkeypatch.setattr(server_module.audit_store, "record_sensitive_event", recorded)

    await _record_ssh_input_audit(
        sid="sid",
        session_id="sess",
        tab_id="tab",
        input_data=b"hunter2\n",
        target=("db01", 22, "root"),
        owner="alice",
        sensitive=False,
    )

    recorded.assert_called_once()
    # Answering the prompt consumes it, so the next command is a command again.
    assert key not in server_module._sensitive_prompt_pending


def test_ordinary_output_does_not_mark_a_prompt():
    import torrus.server as server_module
    from torrus.server import _note_output_for_redaction

    key = ("sid", "sess", "tab2")
    server_module._output_tails[key] = ""
    _note_output_for_redaction(key, b"total 4\n-rw-r--r-- 1 root root 9 readme.txt\n")

    assert key not in server_module._sensitive_prompt_pending
