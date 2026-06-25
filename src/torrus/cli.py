import json
import os
import threading
import webbrowser
from pathlib import Path

import click
import uvicorn

from torrus.logging_utils import configure_logging


@click.group()
def main():
    """torrus — web-based SSH terminal."""
    pass


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host")
@click.option("--port", default=8080, show_default=True, help="Bind port")
@click.option("--no-browser", is_flag=True, default=False, help="Don't open browser on startup")
@click.option("--reload", is_flag=True, default=False, hidden=True, help="Dev auto-reload")
@click.option("--ldap-config", "ldap_config", default=None,
              type=click.Path(exists=True, dir_okay=False, resolve_path=True),
              help="Path to ldapgate YAML config to enable LDAP authentication.")
@click.option("--ssl-keyfile", default=None, type=click.Path(exists=True, dir_okay=False),
              help="SSL key file for HTTPS")
@click.option("--ssl-certfile", default=None, type=click.Path(exists=True, dir_okay=False),
              help="SSL certificate file for HTTPS")
@click.option("--log-file", type=click.Path(dir_okay=False, path_type=Path), default=None,
              help="Append application logs to this file.")
def serve(host, port, no_browser, reload, ldap_config, ssl_keyfile, ssl_certfile, log_file):
    """Start the torrus SSH web terminal."""
    if ldap_config:
        os.environ["TORRUS_LDAP_CONFIG"] = ldap_config
        click.echo(f"LDAP authentication enabled ({ldap_config})")

    configure_logging(log_file)
    if log_file:
        os.environ["TORRUS_LOG_FILE"] = str(log_file)

    use_ssl = ssl_keyfile and ssl_certfile
    if not no_browser:
        browse_host = "127.0.0.1" if host == "0.0.0.0" else host
        scheme = "https" if use_ssl else "http"
        url = f"{scheme}://{browse_host}:{port}"
        threading.Timer(1.5, webbrowser.open, args=[url]).start()

    uvicorn.run(
        "torrus.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
        ssl_keyfile=ssl_keyfile,
        ssl_certfile=ssl_certfile,
        log_config=None,
    )


def _print_audit_events(events) -> None:
    for event in events:
        # JSON escaping keeps terminal control sequences inert while retaining
        # an unambiguous representation of the raw input bytes.
        raw = event["input_data"]
        text = raw.decode("utf-8", errors="backslashreplace")
        rendered = json.dumps(text, ensure_ascii=True)
        target = event["ssh_host"] or "unknown"
        if event["ssh_port"]:
            target = f"{target}:{event['ssh_port']}"
        if event["ssh_username"]:
            target = f"{event['ssh_username']}@{target}"
        click.echo(
            f"{event['occurred_at']} {event['ldap_username']} "
            f"target={target} session={event['session_id']} tab={event['tab_id']} {rendered}"
        )


@main.group(invoke_without_command=True)
@click.option("--user", "username", default=None, help="LDAP username to filter by.")
@click.option("--since", default=None, help="ISO date/time, for example 2026-06-21.")
@click.option("--limit", default=100, show_default=True, type=click.IntRange(1, 10000))
@click.pass_context
def audit(ctx: click.Context, username: str | None, since: str | None, limit: int):
    """Read or purge raw terminal-input audit events."""
    if ctx.invoked_subcommand is None:
        from torrus.audit_store import init_db, list_terminal_input_events
        init_db()
        _print_audit_events(list_terminal_input_events(username=username, since=since, limit=limit))


@audit.command("show")
@click.option("--user", "username", default=None, help="LDAP username to filter by.")
@click.option("--since", default=None, help="ISO date/time, for example 2026-06-21.")
@click.option("--limit", default=100, show_default=True, type=click.IntRange(1, 10000))
def audit_show(username: str | None, since: str | None, limit: int):
    from torrus.audit_store import init_db, list_terminal_input_events
    init_db()
    _print_audit_events(list_terminal_input_events(username=username, since=since, limit=limit))


@audit.command("purge")
@click.option("--older-than", default=90, show_default=True, type=click.IntRange(1), help="Age in days.")
def audit_purge(older_than: int):
    from torrus.audit_store import init_db, purge_terminal_input_events
    init_db()
    click.echo(f"Purged {purge_terminal_input_events(older_than)} audit events")
