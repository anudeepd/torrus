"""Tests for torrus.cli Click commands."""

from click.testing import CliRunner
from unittest.mock import patch


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
        args, kwargs = mock_uvicorn.call_args
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
        args, kwargs = mock_uvicorn.call_args
        assert kwargs["host"] == "0.0.0.0"
        assert kwargs["port"] == 9000

    def test_serve_opens_browser(self):
        from torrus.cli import serve
        import torrus.cli as cli_module

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
        args, kwargs = mock_uvicorn.call_args
        assert kwargs["reload"] is True
