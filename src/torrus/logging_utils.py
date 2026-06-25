"""Logging helpers for torrus runtime output."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


class RoutinePollingAccessFilter(logging.Filter):
    """Hide successful Socket.IO long-polling access logs.

    Uvicorn's access logger records every Engine.IO polling request at INFO.
    Those requests are expected heartbeat/transport traffic, and in deployed
    LDAP setups they can bury the connection/auth/SSH errors operators actually
    need.  Failed polling requests are retained.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "uvicorn.access":
            return True
        path = _access_path(record)
        if not path:
            return True
        if not _is_socketio_polling_path(path):
            return True
        status_code = _access_status_code(record)
        return status_code >= 400


def configure_logging(log_file: Path | None = None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )
    suppress_routine_polling_logs()


def suppress_routine_polling_logs() -> None:
    access_logger = logging.getLogger("uvicorn.access")
    if any(isinstance(f, RoutinePollingAccessFilter) for f in access_logger.filters):
        return
    access_logger.addFilter(RoutinePollingAccessFilter())


def _access_path(record: logging.LogRecord) -> str:
    args = record.args
    if isinstance(args, tuple):
        # Uvicorn access records use:
        # (client_addr, method, full_path, http_version, status_code)
        if len(args) >= 3 and isinstance(args[2], str):
            return args[2]
    if isinstance(args, dict):
        path = args.get("path") or args.get("full_path")
        if isinstance(path, str):
            return path
    message = record.getMessage()
    marker = " /socket.io/"
    idx = message.find(marker)
    if idx == -1:
        return ""
    tail = message[idx + 1 :]
    return tail.split(" ", 1)[0]


def _access_status_code(record: logging.LogRecord) -> int:
    args = record.args
    if isinstance(args, tuple) and len(args) >= 5:
        try:
            return int(args[4])
        except (TypeError, ValueError):
            return 0
    if isinstance(args, dict):
        try:
            return int(args.get("status_code", 0))
        except (TypeError, ValueError):
            return 0
    return 0


def _is_socketio_polling_path(path: str) -> bool:
    parsed = urlsplit(path)
    if parsed.path.rstrip("/") != "/socket.io":
        return False
    query = parse_qs(parsed.query)
    return query.get("transport") == ["polling"]
