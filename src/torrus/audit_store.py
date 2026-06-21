"""Persistent raw terminal-input audit storage for LDAP deployments."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _db_path() -> Path:
    """Return the audit database path, allowing an explicit operator override."""
    configured = os.getenv("TORRUS_AUDIT_DB")
    if configured:
        return Path(configured).expanduser()
    data_home = Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return data_home / "torrus" / "audit.db"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    connection = sqlite3.connect(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return connection


def init_db() -> None:
    with _connect() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS terminal_input_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                ldap_username TEXT NOT NULL,
                session_id TEXT NOT NULL,
                tab_id TEXT NOT NULL,
                ssh_host TEXT,
                ssh_port INTEGER,
                ssh_username TEXT,
                input_data BLOB NOT NULL
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS terminal_input_events_lookup "
            "ON terminal_input_events (ldap_username, occurred_at)"
        )
        # Existing early audit databases are upgraded in place.
        for column in ("ssh_host TEXT", "ssh_port INTEGER", "ssh_username TEXT"):
            try:
                db.execute(f"ALTER TABLE terminal_input_events ADD COLUMN {column}")
            except sqlite3.OperationalError:
                pass


async def record_terminal_input(*, ldap_username: str, session_id: str, tab_id: str,
                                input_data: str | bytes, ssh_host: str | None = None,
                                ssh_port: int | None = None, ssh_username: str | None = None) -> None:
    """Store one Socket.IO input payload exactly as bytes received by the SSH layer."""
    raw = input_data.encode("utf-8", errors="replace") if isinstance(input_data, str) else input_data
    occurred_at = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.execute(
            "INSERT INTO terminal_input_events "
            "(occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, raw),
        )


def list_terminal_input_events(*, username: str | None = None, since: str | None = None,
                               limit: int = 100) -> list[dict]:
    clauses: list[str] = []
    values: list[object] = []
    if username:
        clauses.append("ldap_username = ?")
        values.append(username)
    if since:
        clauses.append("occurred_at >= ?")
        values.append(since)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with _connect() as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            "SELECT occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data "
            f"FROM terminal_input_events{where} ORDER BY id DESC LIMIT ?",
            (*values, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def purge_terminal_input_events(older_than_days: int) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    with _connect() as db:
        cursor = db.execute("DELETE FROM terminal_input_events WHERE occurred_at < ?", (cutoff,))
        return cursor.rowcount
