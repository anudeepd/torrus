"""Persistent terminal command audit storage for LDAP deployments."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from torrus.admin_state import action_payload, new_action_id

_ANSI_RE = re.compile(
    r"\x1B\[[\d;]*[A-Za-z]"  # CSI sequences
    r"|\x1B\].*?(?:\x1B\\|\x07)"  # OSC sequences (ST or BEL terminated)
    r"|\x1B[\x40-\x5F]"  # 2-byte escape sequences
    r"|[\x00-\x07\x0b\x0c\x0e-\x1f]"  # control chars except tab(\t), BS(\b), CR(\r), LF(\n), DEL(\x7f)
)

REDACTED_INPUT = "[redacted sensitive input]"
_SENSITIVE_COMMAND_RE = re.compile(
    r"(?:(?:^|[^A-Za-z0-9])(?:password|passphrase|passcode|token|secret|api[_-]?key|access[_-]?key)"
    r"\s*[:=]\s*\S+"
    r"|--(?:password|passphrase|passcode|token|secret|api[_-]?key|access[_-]?key)(?:=|\s+)\S+"
    r"|(?:^|\s)-p\S+)",
    re.IGNORECASE,
)


def strip_escape(text: str) -> str:
    """Remove ANSI escape sequences and control characters from terminal text."""
    text = _ANSI_RE.sub("", text)
    result: list[str] = []
    for ch in text:
        if ch in ("\b", "\x7f"):
            if result:
                result.pop()
        else:
            result.append(ch)
    return "".join(result)


def is_sensitive_command(value: str) -> bool:
    """Return whether command text contains an inline credential value."""
    return bool(_SENSITIVE_COMMAND_RE.search(value))


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
    connection = sqlite3.connect(path, timeout=30)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
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
                input_data BLOB NOT NULL,
                event_kind TEXT NOT NULL DEFAULT 'terminal_input'
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS terminal_input_events_lookup "
            "ON terminal_input_events (ldap_username, occurred_at)"
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_actions (
                action_id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                status TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS admin_actions_idempotency "
            "ON admin_actions (actor, action, idempotency_key)"
        )
        # Existing early audit databases are upgraded in place.
        for column in (
            "ssh_host TEXT",
            "ssh_port INTEGER",
            "ssh_username TEXT",
            "event_kind TEXT NOT NULL DEFAULT 'terminal_input'",
        ):
            try:
                db.execute(f"ALTER TABLE terminal_input_events ADD COLUMN {column}")
            except sqlite3.OperationalError:
                pass


async def record_terminal_input(
    *,
    ldap_username: str,
    session_id: str,
    tab_id: str,
    input_data: str | bytes,
    ssh_host: str | None = None,
    ssh_port: int | None = None,
    ssh_username: str | None = None,
) -> None:
    """Store one Socket.IO input payload exactly as bytes received by the SSH layer."""
    raw = (
        input_data.encode("utf-8", errors="replace")
        if isinstance(input_data, str)
        else input_data
    )
    occurred_at = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.execute(
            "INSERT INTO terminal_input_events "
            "(occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data, event_kind) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                occurred_at,
                ldap_username,
                session_id,
                tab_id,
                ssh_host,
                ssh_port,
                ssh_username,
                raw,
                "raw_input",
            ),
        )


async def record_command_event(
    *,
    ldap_username: str,
    session_id: str,
    tab_id: str,
    command: str,
    ssh_host: str | None = None,
    ssh_port: int | None = None,
    ssh_username: str | None = None,
) -> None:
    """Store one complete command (terminated by Enter) for audit."""
    cleaned = strip_escape(command).strip()
    if not cleaned:
        return
    raw = cleaned.encode("utf-8", errors="replace")
    occurred_at = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.execute(
            "INSERT INTO terminal_input_events "
            "(occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data, event_kind) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                occurred_at,
                ldap_username,
                session_id,
                tab_id,
                ssh_host,
                ssh_port,
                ssh_username,
                raw,
                "command",
            ),
        )


async def record_sensitive_event(
    *,
    ldap_username: str,
    session_id: str,
    tab_id: str,
    ssh_host: str | None = None,
    ssh_port: int | None = None,
    ssh_username: str | None = None,
) -> None:
    """Store a redaction marker without persisting sensitive input bytes."""
    occurred_at = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.execute(
            "INSERT INTO terminal_input_events "
            "(occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data, event_kind) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                occurred_at,
                ldap_username,
                session_id,
                tab_id,
                ssh_host,
                ssh_port,
                ssh_username,
                REDACTED_INPUT.encode("utf-8"),
                "sensitive",
            ),
        )


def list_terminal_input_events(
    *, username: str | None = None, since: str | None = None, limit: int = 100
) -> list[dict]:
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
            "SELECT id, occurred_at, ldap_username, session_id, tab_id, ssh_host, ssh_port, ssh_username, input_data, event_kind "
            f"FROM terminal_input_events{where} ORDER BY id DESC LIMIT ?",
            (*values, min(100, max(1, int(limit)))),
        ).fetchall()
    return [dict(row) for row in rows]


def _action_row(row: sqlite3.Row | tuple | None) -> dict | None:
    if row is None:
        return None
    values = dict(row)
    try:
        values["result"] = (
            json.loads(values.pop("result_json")) if values.get("result_json") else None
        )
    except (TypeError, json.JSONDecodeError):
        values["result"] = None
    values.pop("result_json", None)
    return values


def begin_admin_action(
    *, actor: str, action: str, target: str, idempotency_key: str
) -> tuple[dict, bool]:
    """Create or replay a durable admin action intent."""
    init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.row_factory = sqlite3.Row
        existing = db.execute(
            "SELECT * FROM admin_actions WHERE actor = ? AND action = ? AND idempotency_key = ?",
            (actor, action, idempotency_key),
        ).fetchone()
        if existing is not None:
            return _action_row(existing) or {}, True
        action_id = new_action_id()
        try:
            db.execute(
                "INSERT INTO admin_actions "
                "(action_id, idempotency_key, actor, action, target, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
                (action_id, idempotency_key, actor, action, target, now, now),
            )
        except sqlite3.IntegrityError:
            existing = db.execute(
                "SELECT * FROM admin_actions WHERE actor = ? AND action = ? AND idempotency_key = ?",
                (actor, action, idempotency_key),
            ).fetchone()
            return _action_row(existing) or {}, True
        return {
            "action_id": action_id,
            "idempotency_key": idempotency_key,
            "actor": actor,
            "action": action,
            "target": target,
            "status": "pending",
            "result": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }, False


def complete_admin_action(
    action_id: str, *, status: str, result: dict | None = None, error: str | None = None
) -> dict | None:
    """Persist terminal action outcome and return its envelope."""
    if status not in {"succeeded", "failed", "partial", "unknown"}:
        raise ValueError(f"invalid admin action status: {status}")
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as db:
        db.execute(
            "UPDATE admin_actions SET status = ?, result_json = ?, error = ?, updated_at = ? "
            "WHERE action_id = ?",
            (
                status,
                action_payload(result) if result is not None else None,
                error,
                now,
                action_id,
            ),
        )
        db.row_factory = sqlite3.Row
        return _action_row(
            db.execute(
                "SELECT * FROM admin_actions WHERE action_id = ?", (action_id,)
            ).fetchone()
        )


def get_admin_action(action_id: str) -> dict | None:
    init_db()
    with _connect() as db:
        db.row_factory = sqlite3.Row
        return _action_row(
            db.execute(
                "SELECT * FROM admin_actions WHERE action_id = ?", (action_id,)
            ).fetchone()
        )


def count_terminal_input_events(older_than_days: int) -> int:
    """Count terminal rows eligible for retention purge."""
    days = max(0, int(older_than_days))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with _connect() as db:
        return int(
            db.execute(
                "SELECT COUNT(*) FROM terminal_input_events WHERE occurred_at < ?",
                (cutoff,),
            ).fetchone()[0]
        )


def purge_terminal_input_events(older_than_days: int) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    with _connect() as db:
        cursor = db.execute(
            "DELETE FROM terminal_input_events WHERE occurred_at < ?", (cutoff,)
        )
        return cursor.rowcount
