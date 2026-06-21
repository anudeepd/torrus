import pytest


@pytest.mark.asyncio
async def test_terminal_input_audit_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_terminal_input(
        ldap_username="alice", session_id="session-1", tab_id="tab-1", input_data="ls -la\r",
        ssh_host="example.com", ssh_port=22, ssh_username="root",
    )

    events = audit_store.list_terminal_input_events(username="alice")
    assert len(events) == 1
    assert events[0]["input_data"] == b"ls -la\r"
    assert (events[0]["ssh_host"], events[0]["ssh_port"], events[0]["ssh_username"]) == ("example.com", 22, "root")
    assert audit_store.purge_terminal_input_events(0) == 1
