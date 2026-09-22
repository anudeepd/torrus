"""Tests for torrus.cli Click commands."""

from unittest.mock import patch

from click.testing import CliRunner


class TestServeCommand:
    """Smoke tests for the `torrus serve` CLI."""

    def test_serve_defaults(self):
        from torrus.cli import serve

        runner = CliRunner()
        with (
            patch("torrus.cli.webbrowser.open") as mock_browser,
            patch("torrus.cli.uvicorn.run") as mock_uvicorn,
        ):
            result = runner.invoke(serve, ["--no-browser"])

        assert result.exit_code == 0
        mock_browser.assert_not_called()
        mock_uvicorn.assert_called_once()
        _args, kwargs = mock_uvicorn.call_args
        assert kwargs["host"] == "127.0.0.1"
        assert kwargs["port"] == 8080
        assert kwargs["reload"] is False

    def test_serve_custom_host_port(self):
        from torrus.cli import serve

        runner = CliRunner()
        with (
            patch("torrus.cli.webbrowser.open"),
            patch("torrus.cli.uvicorn.run") as mock_uvicorn,
        ):
            result = runner.invoke(
                serve, ["--host", "0.0.0.0", "--port", "9000", "--no-browser"]
            )

        assert result.exit_code == 0
        _args, kwargs = mock_uvicorn.call_args
        assert kwargs["host"] == "0.0.0.0"
        assert kwargs["port"] == 9000

    def test_serve_opens_browser(self):
        import torrus.cli as cli_module
        from torrus.cli import serve

        captured_args = {}

        class FakeTimer:
            def __init__(self, delay, target, args=()):
                captured_args["delay"] = delay
                captured_args["target"] = target
                captured_args["args"] = args

            def start(self):
                pass

        runner = CliRunner()
        with (
            patch("torrus.cli.threading.Timer", FakeTimer),
            patch("torrus.cli.uvicorn.run"),
        ):
            result = runner.invoke(serve)

        assert result.exit_code == 0
        assert captured_args["target"] is cli_module.webbrowser.open
        assert "127.0.0.1:8080" in captured_args["args"][0]

    def test_serve_ldap_config(self, tmp_path):
        from torrus.cli import serve

        config = tmp_path / "ldap.yaml"
        config.write_text("ldap:\n  url: ldap://localhost\n")

        runner = CliRunner()
        with patch("torrus.cli.webbrowser.open"), patch("torrus.cli.uvicorn.run"):
            result = runner.invoke(
                serve, ["--ldap-config", str(config), "--no-browser"]
            )

        assert result.exit_code == 0
        import os

        assert os.environ.get("TORRUS_LDAP_CONFIG") == str(config)

    def test_serve_reload_flag(self):
        from torrus.cli import serve

        runner = CliRunner()
        with (
            patch("torrus.cli.webbrowser.open"),
            patch("torrus.cli.uvicorn.run") as mock_uvicorn,
        ):
            result = runner.invoke(serve, ["--reload", "--no-browser"])

        assert result.exit_code == 0
        _args, kwargs = mock_uvicorn.call_args
        assert kwargs["reload"] is True

def test_audit_show_escapes_control_characters(tmp_path):
    """Viewing an event must not replay control characters it contains."""
    import os

    from click.testing import CliRunner

    from torrus import audit_store
    from torrus.cli import main

    os.environ["TORRUS_AUDIT_DB"] = str(tmp_path / "audit.db")
    audit_store.init_db()
    audit_store.record_command_event(
        ldap_username="alice",
        session_id="sess1",
        tab_id="tab1",
        command="printf '\x1b[31mred\x1b[0m\rrewritten'",
        ssh_host="db01",
        ssh_port=22,
        ssh_username="root",
    )

    result = CliRunner().invoke(main, ["audit", "show"])

    assert result.exit_code == 0, result.output
    # The stored command keeps a carriage return; the renderer must escape it
    # rather than emit it, or viewing the audit would move the cursor.
    assert "rewritten" in result.output
    # No control character may reach the terminal, newline aside: a carriage
    # return would move the cursor and an ESC would start an escape sequence.
    assert [char for char in result.output if ord(char) < 32 and char != "\n"] == []
    assert "alice" in result.output
    assert "root@db01:22" in result.output


def test_audit_purge_reports_how_many_rows_went(tmp_path):
    import os
    import sqlite3

    from click.testing import CliRunner

    from torrus import audit_store
    from torrus.cli import main

    db = tmp_path / "audit.db"
    os.environ["TORRUS_AUDIT_DB"] = str(db)
    audit_store.init_db()
    with sqlite3.connect(db) as connection:
        connection.execute(
            "INSERT INTO terminal_input_events "
            "(occurred_at, ldap_username, session_id, tab_id, input_data, event_kind) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("2000-01-01T00:00:00+00:00", "alice", "s1", "t1", b"uptime", "command"),
        )

    result = CliRunner().invoke(main, ["audit", "purge", "--older-than", "1"])

    assert result.exit_code == 0, result.output
    assert "Purged 1 audit events" in result.output
    assert audit_store.count_audit_events_older_than(1) == 0
