import pytest


@pytest.mark.asyncio
async def test_terminal_input_audit_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_terminal_input(
        ldap_username="alice",
        session_id="session-1",
        tab_id="tab-1",
        input_data="ls -la\r",
        ssh_host="example.com",
        ssh_port=22,
        ssh_username="root",
    )

    events = audit_store.list_terminal_input_events(username="alice")
    assert len(events) == 1
    assert events[0]["input_data"] == b"ls -la\r"
    assert (
        events[0]["ssh_host"],
        events[0]["ssh_port"],
        events[0]["ssh_username"],
    ) == ("example.com", 22, "root")
    assert audit_store.purge_terminal_input_events(0) == 1
    with audit_store._connect() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


@pytest.mark.asyncio
async def test_record_command_event_stores_cleaned_command(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_command_event(
        ldap_username="bob",
        session_id="sess",
        tab_id="tab",
        command="git push origin main",
        ssh_host="git.example.com",
        ssh_port=22,
        ssh_username="git",
    )

    events = audit_store.list_terminal_input_events(username="bob")
    assert len(events) == 1
    assert events[0]["input_data"] == b"git push origin main"
    assert events[0]["ssh_host"] == "git.example.com"


@pytest.mark.asyncio
async def test_terminal_input_search_matches_partial_username_and_command(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_terminal_input(
        ldap_username="alice",
        session_id="sess-1",
        tab_id="tab-1",
        input_data="git status --short",
    )
    await audit_store.record_terminal_input(
        ldap_username="bob",
        session_id="sess-2",
        tab_id="tab-2",
        input_data="kubectl get pods",
    )

    assert [
        event["ldap_username"]
        for event in audit_store.list_terminal_input_events(username="lic")
    ] == ["alice"]
    assert [
        event["ldap_username"]
        for event in audit_store.list_terminal_input_events(input_query="TATUs")
    ] == ["alice"]


def test_sensitive_command_detection():
    from torrus.audit_store import is_sensitive_command

    assert is_sensitive_command("mysql --password hunter2")
    assert is_sensitive_command("export API_TOKEN=abc123")
    assert is_sensitive_command("mysql -phunter2")
    assert not is_sensitive_command("git push origin main")


@pytest.mark.asyncio
async def test_record_sensitive_event_never_stores_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_sensitive_event(
        ldap_username="alice",
        session_id="sess",
        tab_id="tab",
        ssh_host="example.com",
        ssh_port=22,
        ssh_username="root",
    )

    events = audit_store.list_terminal_input_events(username="alice")
    assert events[0]["event_kind"] == "sensitive"
    assert events[0]["input_data"] == audit_store.REDACTED_INPUT.encode()
    assert b"secret" not in events[0]["input_data"].lower()


def test_strip_escape_removes_ansi_sequences():
    from torrus.audit_store import strip_escape

    assert strip_escape("echo \x1b[32mhello\x1b[0m") == "echo hello"
    assert strip_escape("\x1b[1;31merror\x1b[0m") == "error"
    assert strip_escape("") == ""
    assert strip_escape("hello\x7f") == "hell"
    assert strip_escape("wor\x08\x08ld") == "wld"
    assert strip_escape("plain text") == "plain text"
    assert strip_escape("ls --color") == "ls --color"
    assert strip_escape("a\x03b") == "ab"


def test_strip_escape_removes_bracketed_paste_markers():
    from torrus.audit_store import strip_escape

    assert strip_escape("\x1b[200~echo one\x1b[201~") == "echo one"


@pytest.mark.asyncio
async def test_sftp_event_roundtrip_and_purge(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    await audit_store.record_sftp_event(
        ldap_username="alice",
        session_id="sess",
        tab_id="tab",
        operation="bulk_download",
        path="/etc/passwd",
        size=85,
        detail="",
        ssh_host="h",
        ssh_port=22,
        ssh_username="root",
    )
    await audit_store.record_command_event(
        ldap_username="alice", session_id="sess", tab_id="tab", command="ls"
    )

    events = audit_store.list_sftp_events(username="alice")
    assert [(e["operation"], e["path"], e["size"], e["detail"]) for e in events] == [
        ("bulk_download", "/etc/passwd", 85, "")
    ]
    assert events[0]["ssh_host"] == "h"
    assert audit_store.list_sftp_events(input_query="passwd")
    assert not audit_store.list_sftp_events(input_query="nomatch")
    # Retention count/purge covers both terminal input and SFTP events.
    assert audit_store.count_terminal_input_events(0) == 2
    assert audit_store.purge_terminal_input_events(0) == 2
    assert audit_store.list_sftp_events() == []
