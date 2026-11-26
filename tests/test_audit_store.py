import sqlite3

import pytest


@pytest.mark.asyncio
async def test_terminal_input_audit_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    audit_store.record_terminal_input(
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
    assert audit_store.purge_audit_events_older_than(0) == 1
    with audit_store._connect() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


@pytest.mark.asyncio
async def test_record_command_event_stores_cleaned_command(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    audit_store.record_command_event(
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
    audit_store.record_terminal_input(
        ldap_username="alice",
        session_id="sess-1",
        tab_id="tab-1",
        input_data="git status --short",
    )
    audit_store.record_terminal_input(
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
    # Free-text search spans all columns, not only command text.
    assert [
        event["ldap_username"]
        for event in audit_store.list_terminal_input_events(input_query="SESS-2")
    ] == ["bob"]
    assert (
        audit_store.list_terminal_input_events(input_query="nonexistent-string") == []
    )


@pytest.mark.asyncio
async def test_event_list_filters_by_host_until_kind_and_operation(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    from torrus import audit_store

    audit_store.init_db()
    audit_store.record_command_event(
        ldap_username="alice",
        session_id="sess-1",
        tab_id="tab-1",
        command="systemctl status torrus",
        ssh_host="hivestage.example.com",
        ssh_port=22,
        ssh_username="deploy",
    )
    audit_store.record_sensitive_event(
        ldap_username="alice",
        session_id="sess-1",
        tab_id="tab-1",
        ssh_host="hivestage.example.com",
        ssh_port=22,
        ssh_username="deploy",
    )
    audit_store.record_sftp_event(
        ldap_username="bob",
        session_id="sess-2",
        tab_id="tab-1",
        operation="upload",
        path="restore.sql",
        size=1024,
        ssh_host="db01.internal",
        ssh_port=22,
        ssh_username="root",
    )

    assert [
        event["ssh_host"]
        for event in audit_store.list_terminal_input_events(host="HIVESTAGE")
    ] == ["hivestage.example.com", "hivestage.example.com"]
    assert audit_store.list_terminal_input_events(host="db01.internal") == []
    assert [
        event["event_kind"]
        for event in audit_store.list_terminal_input_events(kind="sensitive")
    ] == ["sensitive"]
    far_past = "2000-01-01T00:00:00+00:00"
    far_future = "2999-01-01T00:00:00+00:00"
    assert audit_store.list_terminal_input_events(until=far_past) == []
    assert audit_store.list_sftp_events(until=far_past) == []
    assert len(audit_store.list_terminal_input_events(until=far_future)) == 2
    assert [
        event["operation"] for event in audit_store.list_sftp_events(operation="upload")
    ] == ["upload"]
    assert audit_store.list_sftp_events(operation="download") == []
    assert [
        event["ldap_username"] for event in audit_store.list_sftp_events(host="db01")
    ] == ["bob"]


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
    audit_store.record_sensitive_event(
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
    assert strip_escape("\x7fhello") == "hello"
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
    audit_store.record_sftp_event(
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
    audit_store.record_command_event(
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
    assert audit_store.count_audit_events_older_than(0) == 2
    assert audit_store.purge_audit_events_older_than(0) == 2
    assert audit_store.list_sftp_events() == []


def test_connect_tolerates_unavoidable_chmod_failures(monkeypatch, tmp_path):
    from pathlib import Path

    from torrus import audit_store

    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))

    def deny_chmod(self, *args, **kwargs):
        raise OSError("not supported")

    monkeypatch.setattr(Path, "chmod", deny_chmod)
    with audit_store._connect() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_default_database_path_uses_xdg_data_home(monkeypatch):
    from torrus import audit_store

    monkeypatch.delenv("TORRUS_AUDIT_DB", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert audit_store._db_path().as_posix().endswith("/torrus/audit.db")


def test_init_db_does_not_swallow_a_real_migration_failure(monkeypatch):
    from torrus import audit_store

    class BrokenDatabase:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, *_params):
            if statement.startswith("ALTER TABLE terminal_input_events"):
                raise sqlite3.OperationalError("database is locked")
            return self

    monkeypatch.setattr(audit_store, "_connect", BrokenDatabase)
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        audit_store.init_db()


def test_empty_command_is_not_persisted(monkeypatch, tmp_path):
    from torrus import audit_store

    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    audit_store.init_db()
    audit_store.record_command_event(
        ldap_username="alice",
        session_id="sess",
        tab_id="tab",
        command=" \x1b[31m\x1b[0m ",
    )

    assert audit_store.list_terminal_input_events() == []


def test_since_filter_is_applied_to_both_event_tables(monkeypatch, tmp_path):
    from torrus import audit_store

    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    audit_store.init_db()
    audit_store.record_command_event(
        ldap_username="alice", session_id="s", tab_id="t", command="ls"
    )
    audit_store.record_sftp_event(
        ldap_username="alice",
        session_id="s",
        tab_id="t",
        operation="upload",
        path="/x",
        size=1,
    )
    future = "2999-01-01T00:00:00+00:00"

    assert audit_store.list_terminal_input_events(since=future) == []
    assert audit_store.list_sftp_events(since=future) == []


def test_action_rows_tolerate_missing_and_invalid_json():
    from torrus import audit_store

    assert audit_store._action_row(None) is None
    assert audit_store._action_row({"action_id": "a", "result_json": "{bad"}) == {
        "action_id": "a",
        "result": None,
    }


def test_admin_action_replays_and_completes(monkeypatch, tmp_path):
    from torrus import audit_store

    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    action, replay = audit_store.begin_admin_action(
        actor="alice", action="disable", target="bob", idempotency_key="key-1"
    )
    assert replay is False
    assert action["status"] == "pending"

    again, replay = audit_store.begin_admin_action(
        actor="alice", action="disable", target="bob", idempotency_key="key-1"
    )
    assert replay is True
    assert again["action_id"] == action["action_id"]

    completed = audit_store.complete_admin_action(
        action["action_id"], status="succeeded", result={"ok": True}
    )
    assert completed["result"] == {"ok": True}
    assert audit_store.get_admin_action(action["action_id"])["status"] == "succeeded"
    assert audit_store.get_admin_action("missing") is None

    with pytest.raises(ValueError, match="invalid admin action status"):
        audit_store.complete_admin_action(action["action_id"], status="bogus")


def test_admin_action_handles_an_insert_race(monkeypatch, tmp_path):
    from contextlib import contextmanager

    from torrus import audit_store

    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    audit_store.init_db()
    action, _ = audit_store.begin_admin_action(
        actor="alice", action="disable", target="bob", idempotency_key="race"
    )
    real_connect = audit_store._connect

    class RacingDatabase:
        def __init__(self, db):
            self.db = db
            self.selects = 0

        def __enter__(self):
            self.db.__enter__()
            return self

        def __exit__(self, *args):
            return self.db.__exit__(*args)

        def execute(self, statement, params=()):
            if statement.startswith("SELECT * FROM admin_actions"):
                self.selects += 1
                if self.selects == 1:
                    class Empty:
                        def fetchone(self):
                            return None

                    return Empty()
            if statement.startswith("INSERT INTO admin_actions"):
                raise sqlite3.IntegrityError("unique")
            return self.db.execute(statement, params)

        @property
        def row_factory(self):
            return self.db.row_factory

        @row_factory.setter
        def row_factory(self, value):
            self.db.row_factory = value

    @contextmanager
    def racing_connect():
        with real_connect() as db:
            yield RacingDatabase(db)

    monkeypatch.setattr(audit_store, "_connect", racing_connect)
    replay, replay_flag = audit_store.begin_admin_action(
        actor="alice", action="disable", target="bob", idempotency_key="race"
    )
    assert replay_flag is True
    assert replay["action_id"] == action["action_id"]
