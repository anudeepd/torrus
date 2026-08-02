"""FastAPI + Socket.IO ASGI application."""

from __future__ import annotations

import asyncio
import base64
from http.cookies import SimpleCookie
import ipaddress
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path
from urllib.parse import quote, urlparse

import socketio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from torrus import audit_store
from torrus.admin_state import (
    LDAPPolicyStore,
    PolicyConflict,
    PolicyError,
)
from torrus.logging_utils import configure_logging, suppress_routine_polling_logs
from torrus.sftp_manager import SFTPError, SFTPManager
from torrus.ssh_manager import INPUT_QUEUE_MAX_BYTES, SSHManager

logger = logging.getLogger("torrus.server")

if _log_file := os.getenv("TORRUS_LOG_FILE"):
    configure_logging(Path(_log_file))
else:
    suppress_routine_polling_logs()

_SAFE_ID = re.compile(r"^[a-zA-Z0-9_\-]+$")
_DEV_MODE = bool(os.getenv("TORRUS_DEV"))


def _dev_socket_origins() -> list[str]:
    return [
        f"http://{host}:{port}"
        for host in ("localhost", "127.0.0.1")
        for port in (8080, *range(5173, 5184))
    ]


_DEV_ORIGINS = _dev_socket_origins() if _DEV_MODE else []
_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = os.getenv(
    "TORRUS_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP", "true"
).lower() in {"1", "true", "yes", "on"}
_MAX_SESSIONS_PER_SID = 20
APP_CSP = (
    "default-src 'self'; "
    "connect-src 'self' ws: wss:; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self' data:"
)
APP_SHELL_CACHE_CONTROL = "no-cache, must-revalidate"
HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"


def _safe_int(value, default: int) -> int:
    """Parse an integer from untrusted input, returning default on failure."""
    if value is None:
        return default
    if not isinstance(value, (int, float, str)):
        logger.warning("_safe_int received non-numeric type %s", type(value).__name__)
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        logger.warning("_safe_int failed to parse %r", value)
        return default


def _valid_id(value: str) -> bool:
    """Check that an ID contains only safe characters."""
    return bool(value and _SAFE_ID.match(value))


def _static_dir() -> Path | None:
    try:
        p = Path(str(files("torrus").joinpath("static")))
        return p if p.exists() else None
    except (TypeError, FileNotFoundError, ImportError):
        return None
    except Exception:
        logger.warning("_static_dir failed", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Socket.IO + FastAPI setup
# ---------------------------------------------------------------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=_DEV_ORIGINS,
    max_http_buffer_size=10_000_000,
    ping_timeout=60,
    ping_interval=25,
    logger=False,
    engineio_logger=False,
)


@asynccontextmanager
async def lifespan(app):
    if _ldap_enabled:
        audit_store.init_db()
    ssh_manager.start_background_tasks()
    yield
    await sftp_manager.shutdown()
    await ssh_manager.stop_background_tasks()


fastapi_app = FastAPI(title="torrus", docs_url=None, redoc_url=None, lifespan=lifespan)


@fastapi_app.middleware("http")
async def add_app_security_headers(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/_auth/"):
        response.headers.setdefault("Content-Security-Policy", APP_CSP)
    if request.url.path.startswith("/assets/"):
        response.headers.setdefault("Cache-Control", HASHED_ASSET_CACHE_CONTROL)
    if request.url.path.startswith("/api/admin/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = "Cookie"
    return response


# CORS for Vite dev server
if _DEV_MODE:
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=_DEV_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# LDAP state (populated later if config is present)
_ldap_enabled = False
_authenticated_sids: set[str] = set()
_authenticated_users: dict[str, str] = {}
_auth_lock = asyncio.Lock()
_ldap_config = None
_ldap_session_manager = None

_RATE_LIMIT_WINDOW_SEC = 60
_RATE_LIMIT_MAX = 10
_connection_attempts: dict[str, list[float]] = {}
_SFTP_INLINE_TRANSFER_MAX = int(
    os.getenv("TORRUS_SFTP_INLINE_MAX_BYTES", str(5 * 1024 * 1024))
)
_sid_client_ips: dict[str, str] = {}

# Per-socket/session/tab input buffers for command-level audit. A reconnect gets
# a new socket id, so it cannot complete an unfinished command from another
# authenticated browser session.
_input_buffers: dict[tuple[str, str, str], bytearray] = {}
_sensitive_input_buffers: dict[tuple[str, str, str], bytearray] = {}
_input_buffer_lock = asyncio.Lock()
_MAX_INPUT_BUFFER = 1_048_576
_ADMIN_USERS = {
    value.strip().lower()
    for value in os.getenv("TORRUS_ADMIN_USERS", "").split(",")
    if value.strip()
}
_PENDING_DISABLED_USERS: set[str] = set()
_ADMIN_CSRF_TTL = 3600
_admin_csrf_tokens: dict[str, tuple[str, float]] = {}
_admin_sids: set[str] = set()
_admin_stream_epoch = secrets.token_urlsafe(9)
_admin_stream_sequence = 0
_admin_stream_lock = asyncio.Lock()

# Combined ASGI app — uvicorn runs this
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

_IO_WORKERS = max(32, min(128, (os.cpu_count() or 4) * 8))
sftp_manager = SFTPManager(max_workers=max(16, min(64, (os.cpu_count() or 4) * 4)))
ssh_manager = SSHManager(
    sio,
    on_disconnect=sftp_manager.on_ssh_disconnect,
    max_workers=_IO_WORKERS,
)


# ---------------------------------------------------------------------------
# Static files + SPA fallback (only when built frontend exists)
# ---------------------------------------------------------------------------

_static = _static_dir()

if _static:
    # Serve /assets/ from Vite build output
    assets_dir = _static / "assets"
    if assets_dir.exists():
        fastapi_app.mount(
            "/assets", StaticFiles(directory=str(assets_dir)), name="assets"
        )


def _ensure_ldapgate_static_paths(config) -> None:
    """Allow login-page assets to load without exposing the SPA bundle."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if (
        getattr(proxy_config, "session_cookie_name", "ldapgate_session")
        == "ldapgate_session"
    ):
        proxy_config.session_cookie_name = "torrus_session"
    static_paths = list(getattr(proxy_config, "static_paths", []) or [])
    for path in ("/favicon.svg", "/favicon.ico"):
        if path not in static_paths:
            static_paths.append(path)
    proxy_config.static_paths = static_paths


_ldap_config_path = os.getenv("TORRUS_LDAP_CONFIG")
if _ldap_config_path:
    try:
        from ldapgate.config import load_config
        from ldapgate.middleware import add_ldap_auth
        from ldapgate.sessions import SessionManager
    except ImportError as e:
        raise RuntimeError(
            "ldapgate is not installed but TORRUS_LDAP_CONFIG is set. "
            "Install it with: pip install 'torrus[ldap]' or pip install -e /path/to/ldapgate"
        ) from e
    _login_template = Path(__file__).parent / "templates" / "login.html"
    _ldap_config = load_config(_ldap_config_path)
    _ensure_ldapgate_static_paths(_ldap_config)
    _ldap_session_manager = add_ldap_auth(
        fastapi_app, _ldap_config, template_path=str(_login_template)
    )
    if _ldap_session_manager is None:
        logger.warning(
            "ldapgate.add_ldap_auth did not return a SessionManager; using compatibility fallback"
        )
        _ldap_session_manager = SessionManager(
            _ldap_config.proxy.secret_key.get_secret_value(),
            _ldap_config.proxy.session_ttl,
            revocation_path=_ldap_config.proxy.revocation_path,
            max_sessions_per_user=_ldap_config.proxy.max_sessions_per_user,
            bind_client=_ldap_config.proxy.bind_client,
            idle_timeout=getattr(_ldap_config.proxy, "idle_timeout", 0),
        )
    _ldap_enabled = True


@fastapi_app.get("/favicon.svg", include_in_schema=False)
async def favicon():
    if _static:
        fav = _static / "favicon.svg"
        if fav.exists():
            return FileResponse(str(fav), media_type="image/svg+xml")
    return JSONResponse(status_code=404, content={"detail": "Not found"})


@fastapi_app.get("/api/config", include_in_schema=False)
async def api_config(request: Request):
    ldap_enabled = bool(os.getenv("TORRUS_LDAP_CONFIG"))
    idle_timeout = _safe_int(
        getattr(getattr(_ldap_config, "proxy", None), "idle_timeout", 0),
        0,
    )
    owner = _http_owner(request)
    return {
        "ldap_enabled": ldap_enabled,
        "ldap_idle_timeout": max(0, idle_timeout) if ldap_enabled else 0,
        "is_admin": bool(owner and owner.casefold() in _ADMIN_USERS),
    }


async def _admin_actor(request: Request) -> tuple[str | None, JSONResponse | None]:
    username = _http_owner(request)
    if not username:
        return None, JSONResponse(
            status_code=401, content={"ok": False, "code": "auth_required"}
        )
    if username.lower() not in _ADMIN_USERS:
        return None, JSONResponse(
            status_code=403, content={"ok": False, "code": "admin_required"}
        )
    return username, None


def _admin_hosts(request: Request) -> set[str]:
    configured = getattr(getattr(_ldap_config, "proxy", None), "trusted_hosts", None)
    hosts = {str(host).lower() for host in (configured or []) if str(host).strip()}
    if not hosts:
        host = request.headers.get("host", "").strip().lower()
        if host:
            hosts.add(host)
    if _DEV_MODE:
        hosts.update(urlparse(origin).netloc.lower() for origin in _DEV_ORIGINS)
    return hosts


def _admin_origin_allowed(request: Request) -> bool:
    for header in ("origin", "referer"):
        value = request.headers.get(header)
        if not value:
            continue
        if value == "null":
            return False
        parsed = urlparse(value)
        return parsed.scheme in {
            "http",
            "https",
        } and parsed.netloc.lower() in _admin_hosts(request)
    return True


def _admin_csrf_valid(request: Request) -> bool:
    cookie = request.cookies.get("torrus_admin_csrf")
    supplied = request.headers.get("x-torrus-csrf")
    if not cookie or not supplied or not secrets.compare_digest(cookie, supplied):
        return False
    record = _admin_csrf_tokens.get(cookie)
    if record is None or record[1] < time.time():
        _admin_csrf_tokens.pop(cookie, None)
        return False
    return record[0].casefold() == (_http_owner(request) or "").casefold()


async def _admin_guard(
    request: Request, *, mutate: bool = False
) -> tuple[str | None, JSONResponse | None]:
    actor, error = await _admin_actor(request)
    if error or not actor:
        return actor, error
    if mutate and _ldap_enabled:
        if not _admin_origin_allowed(request):
            return None, JSONResponse(
                status_code=403,
                content={"ok": False, "code": "trusted_origin_required"},
            )
        if not _admin_csrf_valid(request):
            return None, JSONResponse(
                status_code=403,
                content={"ok": False, "code": "csrf_required"},
            )
    return actor, None


def _valid_idempotency_key(value: str | None) -> bool:
    return bool(value and 1 <= len(value) <= 128 and _SAFE_ID.fullmatch(value))


async def _begin_admin_action(
    request: Request, actor: str, action: str, target: str
) -> tuple[dict | None, bool, JSONResponse | None]:
    key = request.headers.get("idempotency-key", "")
    if not isinstance(key, str):
        key = ""
    key = key.strip()
    if not key and not _ldap_enabled:
        key = f"test-{secrets.token_urlsafe(12)}"
    if not _valid_idempotency_key(key):
        return (
            None,
            False,
            JSONResponse(
                status_code=400,
                content={"ok": False, "code": "idempotency_key_required"},
            ),
        )
    record, replayed = await asyncio.to_thread(
        audit_store.begin_admin_action,
        actor=actor,
        action=action,
        target=target,
        idempotency_key=key,
    )
    return record, replayed, None


def _replayed_action(record: dict) -> JSONResponse:
    result = record.get("result") or {
        "ok": False,
        "status": record.get("status", "pending"),
    }
    content = dict(result)
    content.update(
        action_id=record.get("action_id"),
        replayed=True,
        status=record.get("status", "pending"),
    )
    code = (
        202
        if record.get("status") == "pending"
        else 200
        if record.get("status") == "succeeded"
        else 409
    )
    return JSONResponse(status_code=code, content=content)


async def _finish_admin_action(
    record: dict,
    *,
    status: str,
    result: dict | None = None,
    error: str | None = None,
) -> dict:
    completed = await asyncio.to_thread(
        audit_store.complete_admin_action,
        record["action_id"],
        status=status,
        result=result,
        error=error,
    )
    return completed or {**record, "status": status, "result": result, "error": error}


async def _emit_admin_event(kind: str, data: dict) -> None:
    global _admin_stream_sequence
    async with _admin_stream_lock:
        _admin_stream_sequence += 1
        envelope = {
            "epoch": _admin_stream_epoch,
            "sequence": _admin_stream_sequence,
            "kind": kind,
            "data": data,
            "observed_at": time.time(),
        }
        recipients = tuple(_admin_sids)
    for sid in recipients:
        await sio.emit("admin:event", envelope, room=sid)


@fastapi_app.get("/api/admin/csrf", include_in_schema=False)
async def admin_csrf(request: Request):
    actor, error = await _admin_guard(request)
    if error:
        return error
    token = secrets.token_urlsafe(32)
    _admin_csrf_tokens[token] = (actor or "", time.time() + _ADMIN_CSRF_TTL)
    response = JSONResponse({"ok": True, "token": token, "expires_in": _ADMIN_CSRF_TTL})
    secure = bool(
        getattr(getattr(_ldap_config, "proxy", None), "secure_cookies", False)
    )
    response.set_cookie(
        "torrus_admin_csrf",
        token,
        max_age=_ADMIN_CSRF_TTL,
        secure=secure,
        httponly=False,
        samesite="strict",
    )
    return response


@fastapi_app.get("/admin", include_in_schema=False)
async def admin_shell(request: Request):
    """Serve admin shell only after LDAP/admin authorization."""
    _actor, error = await _admin_guard(request)
    if error:
        return error
    if not _static:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "code": "frontend_unbuilt"},
        )
    index = _static / "index.html"
    if not index.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "code": "frontend_unbuilt"},
        )
    return FileResponse(str(index), headers={"Cache-Control": APP_SHELL_CACHE_CONTROL})


@fastapi_app.get("/api/admin/actions/{action_id}", include_in_schema=False)
async def admin_action_status(action_id: str, request: Request):
    actor, error = await _admin_guard(request)
    if error:
        return error
    if not _valid_id(action_id):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    record = await asyncio.to_thread(audit_store.get_admin_action, action_id)
    if record is None or record.get("actor", "").casefold() != (actor or "").casefold():
        return JSONResponse(
            status_code=404, content={"ok": False, "code": "action_not_found"}
        )
    return {"ok": True, **record}


@fastapi_app.get("/api/admin/policy", include_in_schema=False)
async def admin_policy(request: Request):
    _actor, error = await _admin_guard(request)
    if error:
        return error
    try:
        snapshot = await asyncio.to_thread(LDAPPolicyStore(_ldap_config_path).snapshot)
    except (PolicyError, OSError) as exc:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "code": "policy_unavailable", "message": str(exc)},
        )
    return {
        "ok": True,
        "fingerprint": snapshot["fingerprint"],
        "allowed_users": snapshot["allowed_users"],
        "pending_users": sorted(_PENDING_DISABLED_USERS),
        "restart_required": bool(_PENDING_DISABLED_USERS),
    }


async def _revoke_ldap_user(username: str) -> tuple[int, int]:
    """Revoke LDAP cookies and close live Torrus tabs for one identity."""
    session_manager = _ldap_session_manager
    revoke_user_sessions = getattr(session_manager, "revoke_user_sessions", None)
    if not callable(revoke_user_sessions):
        raise RuntimeError("LDAPGate user-wide revocation is unavailable")
    revoked = await asyncio.to_thread(revoke_user_sessions, username)
    closed = await ssh_manager.terminate_owner_sessions(username)
    async with _auth_lock:
        revoked_sids = [
            sid
            for sid, user in _authenticated_users.items()
            if user.casefold() == username.casefold()
        ]
        for sid in revoked_sids:
            _authenticated_sids.discard(sid)
            _authenticated_users.pop(sid, None)
    for sid in revoked_sids:
        await ssh_manager.unmap_sid(sid)
    return int(revoked or 0), closed


def _admin_session_page(
    sessions: list[dict[str, str | int | float]], limit: int, cursor: str | None
) -> tuple[list[dict[str, str | int | float]], str | None]:
    start = 0
    if cursor:
        try:
            start = max(0, int(cursor))
        except ValueError:
            start = 0
    page = sessions[start : start + limit]
    next_cursor = str(start + limit) if start + limit < len(sessions) else None
    return page, next_cursor


@fastapi_app.get("/api/admin/users", include_in_schema=False)
async def admin_users(request: Request):
    _actor, error = await _admin_guard(request)
    if error:
        return error
    configured = getattr(getattr(_ldap_config, "ldap", None), "allowed_users", None)
    users = {
        str(user).strip().lower() for user in (configured or []) if str(user).strip()
    }
    sessions = await ssh_manager.list_sessions()
    users.update(
        str(session["owner_ldap_username"]).lower()
        for session in sessions
        if session["owner_ldap_username"]
    )
    return {
        "items": [
            {
                "username": username,
                "active_sessions": sum(
                    session["owner_ldap_username"].lower() == username
                    for session in sessions
                ),
                "policy_state": (
                    "pending_disable"
                    if username in _PENDING_DISABLED_USERS
                    else "allowed"
                ),
            }
            for username in sorted(users)
        ],
        "observed_at": time.time(),
    }


@fastapi_app.get("/api/admin/sessions", include_in_schema=False)
async def admin_sessions(request: Request):
    _actor, error = await _admin_guard(request)
    if error:
        return error
    try:
        limit = min(100, max(1, int(request.query_params.get("limit", "100"))))
    except ValueError:
        limit = 100
    sessions = await ssh_manager.list_sessions()
    sessions.sort(key=lambda item: float(item["created_at"]), reverse=True)
    page, next_cursor = _admin_session_page(
        sessions, limit, request.query_params.get("cursor")
    )
    return {"items": page, "next_cursor": next_cursor, "observed_at": time.time()}


def _display_audit_input(value: bytes | str | None) -> str:
    raw = (
        value.decode("utf-8", errors="replace")
        if isinstance(value, (bytes, bytearray))
        else str(value or "")
    )
    return audit_store.strip_escape(raw).replace("\r\n", "\n").replace("\r", "\n")


@fastapi_app.get("/api/admin/activity", include_in_schema=False)
async def admin_activity(request: Request):
    _actor, error = await _admin_guard(request)
    if error:
        return error
    try:
        limit = min(100, max(1, int(request.query_params.get("limit", "100"))))
    except ValueError:
        limit = 100
    username = request.query_params.get("username") or None
    events = await asyncio.to_thread(
        audit_store.list_terminal_input_events,
        username=username,
        since=request.query_params.get("since") or None,
        limit=limit,
    )
    return {
        "items": [
            {
                "event_id": event["id"],
                "occurred_at": event["occurred_at"],
                "ldap_username": event["ldap_username"],
                "session_id": event["session_id"],
                "tab_id": event["tab_id"],
                "ssh_host": event["ssh_host"],
                "ssh_port": event["ssh_port"],
                "ssh_username": event["ssh_username"],
                "kind": event.get("event_kind", "terminal_input"),
                "input": (
                    "Sensitive input redacted"
                    if event.get("event_kind") == "sensitive"
                    else _display_audit_input(event.get("input_data"))
                ),
                "bytes": (
                    0
                    if event.get("event_kind") == "sensitive"
                    else len(event["input_data"] or b"")
                ),
            }
            for event in events
        ],
        "observed_at": time.time(),
    }


@fastapi_app.get("/api/admin/retention", include_in_schema=False)
async def admin_retention(request: Request):
    _actor, error = await _admin_guard(request)
    if error:
        return error
    try:
        days = int(request.query_params.get("older_than_days", "30"))
    except ValueError:
        days = 30
    days = max(7, min(3650, days))
    eligible = await asyncio.to_thread(audit_store.count_terminal_input_events, days)
    return {
        "cutoff_days": days,
        "minimum_age_days": 7,
        "eligible_count": eligible,
        "terminal_rows_only": True,
        "admin_events_retained": True,
        "observed_at": time.time(),
    }


def _valid_admin_identity(value: str) -> bool:
    return bool(value) and len(value) <= 128 and "\x00" not in value


async def _admin_action_response(
    record: dict,
    *,
    status: str,
    result: dict,
    event_kind: str,
) -> dict | JSONResponse:
    completed = await _finish_admin_action(record, status=status, result=result)
    payload = dict(result)
    payload["action_id"] = completed.get("action_id", record["action_id"])
    await _emit_admin_event(event_kind, payload)
    if result.get("ok"):
        return payload
    return JSONResponse(status_code=409, content=payload)


@fastapi_app.post(
    "/api/admin/sessions/{session_instance_id}/interrupt", include_in_schema=False
)
async def admin_interrupt(session_instance_id: str, request: Request):
    actor, error = await _admin_guard(request, mutate=True)
    if error:
        return error
    try:
        body = await request.json()
        generation = int(body.get("generation"))
    except (ValueError, TypeError, AttributeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    record, replayed, error = await _begin_admin_action(
        request, actor or "", "interrupt", session_instance_id
    )
    if error:
        return error
    if replayed:
        return _replayed_action(record or {})
    result = await ssh_manager.interrupt_session(session_instance_id, generation)
    payload = {
        "ok": result in {"sent", "queued"},
        "status": result,
        "generation": generation,
    }
    return await _admin_action_response(
        record or {},
        status="succeeded" if payload["ok"] else "failed",
        result=payload,
        event_kind="interrupt",
    )


@fastapi_app.post(
    "/api/admin/sessions/{session_instance_id}/kick", include_in_schema=False
)
async def admin_kick(session_instance_id: str, request: Request):
    actor, error = await _admin_guard(request, mutate=True)
    if error:
        return error
    try:
        body = await request.json()
        generation = int(body.get("generation"))
    except (ValueError, TypeError, AttributeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    record, replayed, error = await _begin_admin_action(
        request, actor or "", "kick", session_instance_id
    )
    if error:
        return error
    if replayed:
        return _replayed_action(record or {})
    result = await ssh_manager.terminate_session(session_instance_id, generation)
    payload = {
        "ok": result == "closed",
        "status": result,
        "generation": generation,
    }
    return await _admin_action_response(
        record or {},
        status="succeeded" if payload["ok"] else "failed",
        result=payload,
        event_kind="kick",
    )


async def _policy_mutation(
    username: str, enabled: bool, expected_fingerprint: str | None
) -> dict:
    if not _ldap_config_path:
        return {"fingerprint": None, "backup_id": None, "allowed_users": []}
    mutation = await asyncio.to_thread(
        LDAPPolicyStore(_ldap_config_path).mutate,
        username,
        enabled,
        expected_fingerprint,
    )
    return {
        "fingerprint": mutation.fingerprint,
        "backup_id": mutation.backup_id,
        "allowed_users": list(mutation.allowed_users),
    }


async def _restore_ldap_user(username: str) -> None:
    restore = getattr(_ldap_session_manager, "restore_user_sessions", None)
    if not callable(restore):
        raise RuntimeError("LDAPGate user-wide revocation restore is unavailable")
    await asyncio.to_thread(restore, username)


@fastapi_app.post("/api/admin/users/{username}/disable", include_in_schema=False)
async def admin_disable_user(username: str, request: Request):
    actor, error = await _admin_guard(request, mutate=True)
    if error:
        return error
    normalized = username.strip().casefold()
    if not _valid_admin_identity(normalized):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    if normalized in _ADMIN_USERS:
        return JSONResponse(
            status_code=409,
            content={"ok": False, "code": "admin_protected"},
        )
    try:
        body = await request.json()
    except Exception:
        body = {}
    expected = body.get("expected_fingerprint") if isinstance(body, dict) else None
    record, replayed, error = await _begin_admin_action(
        request, actor or "", "disable_user", normalized
    )
    if error:
        return error
    if replayed:
        return _replayed_action(record or {})
    try:
        revoked_cookies, closed_tabs = await _revoke_ldap_user(normalized)
        policy = await _policy_mutation(normalized, False, expected)
    except RuntimeError as exc:
        payload = {"ok": False, "code": "revocation_unsupported", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=501, content=payload)
    except PolicyConflict as exc:
        payload = {"ok": False, "code": "policy_conflict", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=409, content=payload)
    except (PolicyError, OSError) as exc:
        payload = {"ok": False, "code": "policy_unavailable", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=503, content=payload)
    except Exception:
        logger.exception("LDAP user revocation failed for admin policy change")
        payload = {
            "ok": False,
            "code": "revocation_failed",
            "message": "User policy was not changed because session revocation failed.",
        }
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=payload["message"]
        )
        return JSONResponse(status_code=503, content=payload)
    _PENDING_DISABLED_USERS.add(normalized)
    payload = {
        "ok": True,
        "policy_state": "pending_restart",
        "restart_required": True,
        "revoked_cookies": revoked_cookies,
        "closed_tabs": closed_tabs,
        "fingerprint": policy["fingerprint"],
        "backup_id": policy["backup_id"],
        "message": "LDAP allowlist change queued; restart LDAPGate to enforce it.",
    }
    return await _admin_action_response(
        record or {},
        status="succeeded",
        result=payload,
        event_kind="policy",
    )


@fastapi_app.post("/api/admin/users/{username}/enable", include_in_schema=False)
async def admin_enable_user(username: str, request: Request):
    actor, error = await _admin_guard(request, mutate=True)
    if error:
        return error
    normalized = username.strip().casefold()
    if not _valid_admin_identity(normalized):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    try:
        body = await request.json()
    except Exception:
        body = {}
    expected = body.get("expected_fingerprint") if isinstance(body, dict) else None
    record, replayed, error = await _begin_admin_action(
        request, actor or "", "enable_user", normalized
    )
    if error:
        return error
    if replayed:
        return _replayed_action(record or {})
    try:
        policy = await _policy_mutation(normalized, True, expected)
        await _restore_ldap_user(normalized)
    except RuntimeError as exc:
        payload = {"ok": False, "code": "revocation_unsupported", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=501, content=payload)
    except PolicyConflict as exc:
        payload = {"ok": False, "code": "policy_conflict", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=409, content=payload)
    except (PolicyError, OSError) as exc:
        payload = {"ok": False, "code": "policy_unavailable", "message": str(exc)}
        await _finish_admin_action(
            record or {}, status="failed", result=payload, error=str(exc)
        )
        return JSONResponse(status_code=503, content=payload)
    _PENDING_DISABLED_USERS.discard(normalized)
    payload = {
        "ok": True,
        "policy_state": "pending_restart",
        "restart_required": True,
        "fingerprint": policy["fingerprint"],
        "backup_id": policy["backup_id"],
    }
    return await _admin_action_response(
        record or {},
        status="succeeded",
        result=payload,
        event_kind="policy",
    )


@fastapi_app.post("/api/admin/retention/purge", include_in_schema=False)
async def admin_purge(request: Request):
    actor, error = await _admin_guard(request, mutate=True)
    if error:
        return error
    try:
        body = await request.json()
        days = int(body.get("older_than_days"))
        confirmation = body.get("confirmation")
    except (ValueError, TypeError, AttributeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    if days < 7 or days > 3650 or confirmation != "PURGE":
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "code": "confirmation_required",
                "message": "Use confirmation PURGE and retention between 7 and 3650 days.",
            },
        )
    record, replayed, error = await _begin_admin_action(
        request,
        actor or "",
        "purge",
        f"terminal:{days}",
    )
    if error:
        return error
    if replayed:
        return _replayed_action(record or {})
    removed = await asyncio.to_thread(audit_store.purge_terminal_input_events, days)
    payload = {"ok": True, "removed": removed, "older_than_days": days}
    return await _admin_action_response(
        record or {},
        status="succeeded",
        result=payload,
        event_kind="purge",
    )


@fastapi_app.post("/sftp/upload", include_in_schema=False)
async def sftp_stream_upload(request: Request):
    session_id = request.query_params.get("session_id", "")
    tab_id = request.query_params.get("tab_id", "")
    remote_path = request.query_params.get("path", "")
    upload_id = request.query_params.get("upload_id", "")
    try:
        offset = int(request.query_params.get("offset", "0"))
        total = int(request.query_params.get("total", "-1"))
    except ValueError:
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    complete = request.query_params.get("complete", "false").lower() == "true"
    if (
        not _valid_id(session_id)
        or not _valid_id(tab_id)
        or not _valid_id(upload_id)
        or not remote_path
    ):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    owner = _http_owner(request)
    if _ldap_enabled and not owner:
        return JSONResponse(
            status_code=401, content={"ok": False, "code": "auth_required"}
        )
    if (
        _ldap_enabled
        and await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        is None
    ):
        return JSONResponse(
            status_code=403, content={"ok": False, "code": "session_owner_mismatch"}
        )
    try:
        result = await sftp_manager.upload_chunk(
            tab_id,
            remote_path,
            upload_id,
            offset,
            total,
            request.stream(),
            complete,
            expected_session_id=session_id,
        )
        return JSONResponse(content=result)
    except SFTPError as exc:
        return JSONResponse(
            status_code=404
            if exc.code == "FILE_NOT_FOUND"
            else 403
            if exc.code == "PERMISSION_DENIED"
            else 400,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )


@fastapi_app.post("/sftp/upload/init", include_in_schema=False)
async def sftp_upload_init(request: Request):
    session_id = request.query_params.get("session_id", "")
    tab_id = request.query_params.get("tab_id", "")
    upload_id = request.query_params.get("upload_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id) or not _valid_id(upload_id):
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    owner = _http_owner(request)
    if _ldap_enabled and not owner:
        return JSONResponse(
            status_code=401, content={"ok": False, "code": "auth_required"}
        )
    if (
        _ldap_enabled
        and await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        is None
    ):
        return JSONResponse(
            status_code=403, content={"ok": False, "code": "session_owner_mismatch"}
        )
    try:
        opened = await sftp_manager.open_upload_channel(
            tab_id,
            upload_id,
            ssh_manager,
            expected_session_id=session_id,
        )
    except SFTPError as exc:
        return JSONResponse(
            status_code=403,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )
    if not opened:
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "CONNECTION_CLOSED"}
        )
    return JSONResponse(content={"ok": True})


@fastapi_app.get("/sftp/download", include_in_schema=False)
async def sftp_stream_download(request: Request):
    session_id = request.query_params.get("session_id", "")
    tab_id = request.query_params.get("tab_id", "")
    remote_path = request.query_params.get("path", "")
    if not _valid_id(session_id) or not _valid_id(tab_id) or not remote_path:
        return JSONResponse(
            status_code=400, content={"ok": False, "code": "invalid_request"}
        )
    owner = _http_owner(request)
    if _ldap_enabled and not owner:
        return JSONResponse(
            status_code=401, content={"ok": False, "code": "auth_required"}
        )
    if (
        _ldap_enabled
        and await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        is None
    ):
        return JSONResponse(
            status_code=403, content={"ok": False, "code": "session_owner_mismatch"}
        )

    try:
        download = await sftp_manager.prepare_download(
            tab_id, remote_path, expected_session_id=session_id
        )
    except SFTPError as exc:
        return JSONResponse(
            status_code=404
            if exc.code == "FILE_NOT_FOUND"
            else 403
            if exc.code == "PERMISSION_DENIED"
            else 400,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )

    filename = download["name"] or Path(remote_path).name or "download"
    return StreamingResponse(
        sftp_manager.stream_download(
            tab_id, download["path"], expected_session_id=session_id
        ),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "Content-Length": str(download["size"]),
        },
    )


@fastapi_app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    if full_path.lower().startswith("socket.io"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    if _static:
        index = _static / "index.html"
        if index.exists():
            return FileResponse(
                str(index), headers={"Cache-Control": APP_SHELL_CACHE_CONTROL}
            )
    return JSONResponse(
        status_code=503,
        content={"detail": "Frontend not built. Run: cd frontend && npm run build"},
    )


# ---------------------------------------------------------------------------
# Socket.IO lifecycle
# ---------------------------------------------------------------------------


def _cookie_from_header(cookie_header: str, cookie_name: str) -> str | None:
    if not cookie_header:
        return None
    try:
        cookie = SimpleCookie()
        cookie.load(cookie_header)
    except Exception:
        return None
    morsel = cookie.get(cookie_name)
    return morsel.value if morsel else None


def _header_from_environ(environ, name: str) -> str:
    """Return a request header from Engine.IO's WSGI environ or ASGI scope."""
    wsgi_key = f"HTTP_{name.upper().replace('-', '_')}"
    value = environ.get(wsgi_key)
    if value:
        return value

    scope = environ.get("asgi.scope") or {}
    for raw_name, raw_value in scope.get("headers", []):
        try:
            header_name = raw_name.decode("latin1")
            if header_name.lower() == name.lower():
                return raw_value.decode("latin1")
        except Exception:
            continue
    return ""


def _direct_client_ip_from_environ(environ) -> str:
    """Return the direct peer IP, accounting for Engine.IO's ASGI shim."""
    scope = environ.get("asgi.scope") or {}
    client = scope.get("client")
    if client and client[0]:
        return client[0]
    return environ.get("REMOTE_ADDR", "unknown")


def _dedupe_nonempty(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if not value or value == "unknown" or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _ldap_cookie_name() -> str:
    cookie_name = "ldapgate_session"
    if _ldap_config:
        cookie_name = getattr(_ldap_config.proxy, "session_cookie_name", cookie_name)
        if _ldap_config.proxy.secure_cookies:
            return f"__Host-{cookie_name}"
    return cookie_name


def _client_ip_from_environ(environ) -> str:
    remote = _direct_client_ip_from_environ(environ)
    if not _ldap_config:
        return remote
    trusted = _ldap_config.proxy.trusted_proxies
    if not trusted:
        return remote
    try:
        from ldapgate._auth_utils import _is_ip_in_networks
    except ImportError:
        return remote
    if not _is_ip_in_networks(remote, trusted):
        return remote
    forwarded = _header_from_environ(environ, "x-forwarded-for")
    for entry in reversed([e.strip() for e in forwarded.split(",")]):
        if entry and not _is_ip_in_networks(entry, trusted):
            return entry
    return remote


def _client_ip_candidates_from_environ(environ) -> list[str]:
    """Return plausible client IP bindings for LDAP session verification.

    ldapgate binds session cookies to client IP. Socket.IO requests bypass the
    FastAPI middleware and arrive through Engine.IO's ASGI-to-WSGI shim, so the
    IP visible here can differ from the IP ldapgate saw during login depending
    on uvicorn/proxy-header configuration. Try the primary ldapgate-compatible
    value first, then observed direct/forwarded values.
    """
    values = [
        _client_ip_from_environ(environ),
        _direct_client_ip_from_environ(environ),
        environ.get("REMOTE_ADDR", ""),
    ]
    forwarded = _header_from_environ(environ, "x-forwarded-for")
    if forwarded:
        entries = [entry.strip() for entry in forwarded.split(",") if entry.strip()]
        values.extend(entries)
        values.extend(reversed(entries))
    return _dedupe_nonempty(values)


def _user_agent_from_environ(environ) -> str:
    return _header_from_environ(environ, "user-agent")


def _verify_ldap_socket_session(environ) -> str | None:
    if not _ldap_session_manager:
        return None
    cookie_header = _header_from_environ(environ, "cookie")
    cookie = _cookie_from_header(cookie_header, _ldap_cookie_name())
    if not cookie:
        logger.info("LDAP socket auth failed: missing %s cookie", _ldap_cookie_name())
        return False
    primary_ip = _client_ip_from_environ(environ)
    user_agent = _user_agent_from_environ(environ)
    client_ips = _client_ip_candidates_from_environ(environ)
    user_agents = [user_agent]
    if user_agent:
        user_agents.append("")

    for client_ip in client_ips:
        for candidate_user_agent in user_agents:
            username = _ldap_session_manager.verify_session(
                cookie,
                client_ip=client_ip,
                user_agent=candidate_user_agent,
            )
            if username:
                if username.casefold() in _PENDING_DISABLED_USERS:
                    logger.info("LDAP socket auth blocked for pending-disabled user")
                    return None
                if client_ip != primary_ip or candidate_user_agent != user_agent:
                    logger.info(
                        "LDAP socket auth accepted alternate binding for client_ip=%s "
                        "(primary=%s, user_agent_match=%s)",
                        client_ip,
                        primary_ip,
                        candidate_user_agent == user_agent,
                    )
                return username

    logger.info(
        "LDAP socket auth failed: invalid session cookie for client_ip=%s "
        "(candidates=%s, user_agent_present=%s)",
        primary_ip,
        client_ips,
        bool(user_agent),
    )
    return None


@sio.on("admin:subscribe")
async def on_admin_subscribe(sid, data):
    """Subscribe an authenticated admin to bounded state updates."""
    username = None
    if _ldap_enabled:
        username = _verify_ldap_socket_session(sio.get_environ(sid))
    if not username or username.casefold() not in _ADMIN_USERS:
        return {"ok": False, "code": "admin_required"}
    _admin_sids.add(sid)
    async with _admin_stream_lock:
        sequence = _admin_stream_sequence
    await sio.emit(
        "admin:event",
        {
            "epoch": _admin_stream_epoch,
            "sequence": sequence,
            "kind": "subscribed",
            "data": {"username": username},
            "observed_at": time.time(),
        },
        room=sid,
    )
    return {"ok": True, "epoch": _admin_stream_epoch, "sequence": sequence}


@sio.on("admin:unsubscribe")
async def on_admin_unsubscribe(sid):
    _admin_sids.discard(sid)
    return {"ok": True}


@sio.on("connect")
async def on_connect(sid, environ):
    remote = _direct_client_ip_from_environ(environ)
    forwarded = _header_from_environ(environ, "x-forwarded-for")
    if forwarded:
        remote = forwarded.split(",")[0].strip()
    logger.info("Client connected: %s (from %s)", sid, remote)
    _sid_client_ips[sid] = remote
    if _ldap_enabled:
        try:
            username = _verify_ldap_socket_session(environ)
            if username:
                async with _auth_lock:
                    _authenticated_sids.add(sid)
                    _authenticated_users[sid] = username
                ssh_manager.set_sid_owner(sid, username)
                logger.info("LDAP socket authenticated: %s", sid)
        except Exception:
            logger.warning("LDAP session validation failed", exc_info=True)


@sio.on("disconnect")
async def on_disconnect(sid):
    await ssh_manager.unmap_sid(sid)
    async with _auth_lock:
        _authenticated_sids.discard(sid)
        _authenticated_users.pop(sid, None)
    async with _input_buffer_lock:
        for key in [key for key in _input_buffers if key[0] == sid]:
            del _input_buffers[key]
        for key in [key for key in _sensitive_input_buffers if key[0] == sid]:
            del _sensitive_input_buffers[key]
    _sid_client_ips.pop(sid, None)
    _admin_sids.discard(sid)
    logger.info("Client disconnected: %s", sid)


# ---------------------------------------------------------------------------
# Session registration / recovery
# ---------------------------------------------------------------------------


async def _require_auth(sid: str, tab_id: str) -> bool:
    """Return False and emit an error if LDAP is enabled but the sid is not authenticated."""
    if _ldap_enabled:
        environ = sio.get_environ(sid)
        username = _verify_ldap_socket_session(environ) if environ else None
        authenticated = bool(username)
        if authenticated:
            async with _auth_lock:
                _authenticated_sids.add(sid)
                _authenticated_users[sid] = username
            ssh_manager.set_sid_owner(sid, username)
        if not authenticated:
            await ssh_manager.unmap_sid(sid)
            async with _auth_lock:
                _authenticated_sids.discard(sid)
                _authenticated_users.pop(sid, None)
            logger.info(
                "Blocking unauthenticated socket event for sid=%s tab=%s", sid, tab_id
            )
            await sio.emit(
                "ssh:error",
                {
                    "tab_id": tab_id,
                    "message": "Authentication required.",
                    "code": "auth_required",
                },
                to=sid,
            )
            return False
    return True


async def _owner_for_sid(sid: str) -> str | None:
    if not _ldap_enabled:
        return None
    async with _auth_lock:
        return _authenticated_users.get(sid)


async def _require_session_owner(sid: str, session_id: str, tab_id: str) -> str | None:
    owner = await _owner_for_sid(sid)
    if not _ldap_enabled:
        return ""
    if (
        await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        is None
    ):
        await sio.emit(
            "ssh:error",
            {
                "tab_id": tab_id,
                "message": "Session is not available to this user.",
                "code": "session_owner_mismatch",
            },
            to=sid,
        )
        return None
    return owner


def _http_environ(request: Request) -> dict:
    return {
        "asgi.scope": request.scope,
        "REMOTE_ADDR": request.client.host if request.client else "unknown",
    }


def _http_owner(request: Request) -> str | None:
    if not _ldap_enabled:
        return None
    return _verify_ldap_socket_session(_http_environ(request))


@sio.on("session:register")
async def on_session_register(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return

    status = await ssh_manager.restore_session(sid, session_id, tab_id)
    await sio.emit("session:restored", {"tab_id": tab_id, "status": status}, to=sid)
    if status == "active":
        await ssh_manager.force_redraw(session_id, tab_id)


# ---------------------------------------------------------------------------
# SSH events
# ---------------------------------------------------------------------------


def _is_private_host(host: str) -> bool:
    """Return True if host resolves to a private/local IP address."""
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        pass
    return False


async def _check_rate_limit(sid: str, tab_id: str) -> bool:
    now = time.time()
    # Sweep expired IP buckets so reconnect churn cannot grow this map forever.
    for ip, timestamps in list(_connection_attempts.items()):
        retained = [t for t in timestamps if now - t < _RATE_LIMIT_WINDOW_SEC]
        if retained:
            _connection_attempts[ip] = retained
        else:
            del _connection_attempts[ip]
    client_ip = _sid_client_ips.get(sid, "unknown")
    attempts = _connection_attempts.get(client_ip, [])
    attempts = [t for t in attempts if now - t < _RATE_LIMIT_WINDOW_SEC]
    if len(attempts) >= _RATE_LIMIT_MAX:
        await sio.emit(
            "ssh:error",
            {
                "tab_id": tab_id,
                "message": "Too many connection attempts. Please wait.",
                "code": "rate_limited",
            },
            to=sid,
        )
        return False
    attempts.append(now)
    _connection_attempts[client_ip] = attempts
    return True


@sio.on("ssh:connect")
async def on_ssh_connect(sid, data):
    host = data.get("host", "").strip()
    port = _safe_int(data.get("port", 22), 22)
    username = data.get("username", "").strip()
    password = data.pop("password", "")
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    cols = _safe_int(data.get("cols", 220), 220)
    rows = _safe_int(data.get("rows", 50), 50)

    if not host or not username or not _valid_id(session_id) or not _valid_id(tab_id):
        await sio.emit(
            "ssh:error",
            {
                "tab_id": tab_id,
                "message": "Missing required fields.",
                "code": "invalid_request",
            },
            to=sid,
        )
        return
    if not await _require_auth(sid, tab_id):
        return
    if not await _check_rate_limit(sid, tab_id):
        return
    if ssh_manager.sid_session_count(sid) >= _MAX_SESSIONS_PER_SID:
        await sio.emit(
            "ssh:error",
            {
                "tab_id": tab_id,
                "message": "Too many active sessions.",
                "code": "session_limit",
            },
            to=sid,
        )
        return
    if (
        _is_private_host(host)
        and not _ldap_enabled
        and not _ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP
    ):
        logger.warning("Blocked connection to private host %s from sid %s", host, sid)
        await sio.emit(
            "ssh:error",
            {
                "tab_id": tab_id,
                "message": "Connections to private/local addresses are not allowed.",
                "code": "private_host_blocked",
            },
            to=sid,
        )
        return

    owner = await _owner_for_sid(sid)
    await ssh_manager.connect(
        sid=sid,
        session_id=session_id,
        tab_id=tab_id,
        host=host,
        port=port,
        username=username,
        password=bytearray(password, "utf-8")
        if isinstance(password, str)
        else bytearray(password),
        cols=cols,
        rows=rows,
        owner_ldap_username=owner,
    )


def _extract_commands(buffer: bytearray, incoming: bytes) -> list[str]:
    """Append incoming bytes to *buffer* and extract complete command lines.

    Lines are delimited by ``\\r\\n``, ``\\n``, or ``\\r``.  Each extracted line
    has ANSI escape sequences stripped before being returned.  Partial lines
    remain in *buffer* for the next chunk.
    """
    if incoming:
        buffer.extend(incoming)

    commands: list[str] = []
    while True:
        idx = -1
        sep_len = 0
        for sep in (b"\r\n", b"\n", b"\r"):
            i = buffer.find(sep)
            if i != -1 and (idx == -1 or i < idx):
                idx = i
                sep_len = len(sep)

        if idx == -1:
            break

        cmd_bytes = buffer[:idx]
        del buffer[: idx + sep_len]

        cmd_text = cmd_bytes.decode("utf-8", errors="replace")
        cleaned = audit_store.strip_escape(cmd_text).strip()
        if cleaned:
            commands.append(cleaned)

    return commands


def _extract_sensitive_line_count(buffer: bytearray, incoming: bytes) -> int:
    """Consume complete sensitive-input lines without decoding their contents."""
    if incoming:
        buffer.extend(incoming)

    count = 0
    while True:
        idx = -1
        sep_len = 0
        for sep in (b"\r\n", b"\n", b"\r"):
            i = buffer.find(sep)
            if i != -1 and (idx == -1 or i < idx):
                idx = i
                sep_len = len(sep)
        if idx == -1:
            break
        del buffer[: idx + sep_len]
        count += 1
    return count


@sio.on("ssh:input")
async def on_ssh_input(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    input_data = data.get("data", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return {"ok": False, "error": "Invalid session or tab ID."}
    if not await _require_auth(sid, tab_id):
        return {"ok": False, "error": "Authentication required."}
    if isinstance(input_data, (str, bytes)) and len(input_data) > INPUT_QUEUE_MAX_BYTES:
        return {"ok": False, "error": "Input too large.", "code": "input_too_large"}

    owner = await _owner_for_sid(sid)
    if (
        await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        is None
    ):
        return {
            "ok": False,
            "error": "Session is not available to this user.",
            "code": "session_owner_mismatch",
        }

    if _ldap_enabled and isinstance(input_data, (str, bytes)) and owner:
        target = await ssh_manager.get_session_target(
            session_id, tab_id, owner_ldap_username=owner
        )
        ssh_host, ssh_port, ssh_username = target or (None, None, None)
        raw = (
            input_data.encode("utf-8", errors="replace")
            if isinstance(input_data, str)
            else input_data
        )
        sensitive = data.get("sensitive") is True
        async with _input_buffer_lock:
            key = (sid, session_id, tab_id)
            if sensitive:
                _input_buffers.pop(key, None)
                buf = _sensitive_input_buffers.setdefault(key, bytearray())
                if len(buf) + len(raw) > _MAX_INPUT_BUFFER:
                    buf.clear()
                sensitive_lines = _extract_sensitive_line_count(buf, raw)
                commands: list[str] = []
            else:
                _sensitive_input_buffers.pop(key, None)
                buf = _input_buffers.setdefault(key, bytearray())
                if len(buf) + len(raw) > _MAX_INPUT_BUFFER:
                    buf.clear()
                sensitive_lines = 0
                commands = _extract_commands(buf, raw)
        for _ in range(sensitive_lines):
            try:
                await audit_store.record_sensitive_event(
                    ldap_username=owner,
                    session_id=session_id,
                    tab_id=tab_id,
                    ssh_host=ssh_host,
                    ssh_port=ssh_port,
                    ssh_username=ssh_username,
                )
            except Exception:
                logger.exception("Failed to record sensitive input audit event")
        for cmd in commands:
            try:
                if audit_store.is_sensitive_command(cmd):
                    await audit_store.record_sensitive_event(
                        ldap_username=owner,
                        session_id=session_id,
                        tab_id=tab_id,
                        ssh_host=ssh_host,
                        ssh_port=ssh_port,
                        ssh_username=ssh_username,
                    )
                else:
                    await audit_store.record_command_event(
                        ldap_username=owner,
                        session_id=session_id,
                        tab_id=tab_id,
                        command=cmd,
                        ssh_host=ssh_host,
                        ssh_port=ssh_port,
                        ssh_username=ssh_username,
                    )
            except Exception:
                logger.exception("Failed to record command audit event")
    status = await ssh_manager.handle_input(
        session_id, tab_id, input_data, owner_ldap_username=owner
    )
    if not isinstance(status, str) or status in {"queued", "sent"}:
        return (
            {"ok": True, "status": status} if isinstance(status, str) else {"ok": True}
        )
    return {
        "ok": False,
        "status": status,
        "code": "input_queue_full" if status == "queue_full" else status,
        "error": "Input was not accepted.",
    }


@sio.on("ssh:interrupt")
async def on_ssh_interrupt(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return {"ok": False, "code": "invalid_request"}
    if not await _require_auth(sid, tab_id):
        return {"ok": False, "code": "auth_required"}
    owner = await _owner_for_sid(sid)
    status = await ssh_manager.interrupt(session_id, tab_id, owner_ldap_username=owner)
    if status in {"sent", "queued"}:
        return {"ok": True, "status": status}
    return {"ok": False, "status": status, "code": status}


@sio.on("terminal:resize")
async def on_terminal_resize(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    owner = await _owner_for_sid(sid)
    await ssh_manager.handle_resize(
        session_id,
        tab_id,
        _safe_int(data.get("cols", 80), 80),
        _safe_int(data.get("rows", 24), 24),
        owner_ldap_username=owner,
    )


@sio.on("ssh:disconnect")
async def on_ssh_disconnect(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    owner = await _owner_for_sid(sid)
    result = await ssh_manager.disconnect_session(
        session_id, tab_id, owner_ldap_username=owner
    )
    if result == "forbidden":
        await sio.emit(
            "ssh:error",
            {"tab_id": tab_id, "message": "Session owner mismatch.", "code": result},
            to=sid,
        )
        return
    await sftp_manager.close_sftp(tab_id)
    async with _input_buffer_lock:
        key = (sid, session_id, tab_id)
        _input_buffers.pop(key, None)
        _sensitive_input_buffers.pop(key, None)


@sio.on("sftp:close")
async def on_sftp_close(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    await sftp_manager.close_sftp(tab_id)
    await sio.emit("sftp:close:result", {"tab_id": tab_id, "ok": True}, to=sid)


@sio.on("ssh:clone")
async def on_ssh_clone(sid, data):
    session_id = data.get("session_id", "")
    source_tab_id = data.get("source_tab_id", "")
    new_tab_id = data.get("new_tab_id", "")
    cols = _safe_int(data.get("cols", 220), 220)
    rows = _safe_int(data.get("rows", 50), 50)

    if (
        not _valid_id(session_id)
        or not _valid_id(source_tab_id)
        or not _valid_id(new_tab_id)
    ):
        await sio.emit(
            "ssh:error",
            {
                "tab_id": new_tab_id,
                "message": "Missing required fields.",
                "code": "invalid_request",
            },
            to=sid,
        )
        return
    if not await _require_auth(sid, new_tab_id):
        return
    owner = await _owner_for_sid(sid)
    if _ldap_enabled and (
        await ssh_manager.get_session_target(
            session_id, source_tab_id, owner_ldap_username=owner
        )
        is None
    ):
        await sio.emit(
            "ssh:error",
            {
                "tab_id": new_tab_id,
                "message": "Source session is not available to this user.",
                "code": "session_owner_mismatch",
            },
            to=sid,
        )
        return
    if ssh_manager.sid_session_count(sid) >= _MAX_SESSIONS_PER_SID:
        await sio.emit(
            "ssh:error",
            {
                "tab_id": new_tab_id,
                "message": "Too many active sessions.",
                "code": "session_limit",
            },
            to=sid,
        )
        return

    await ssh_manager.clone(
        sid=sid,
        session_id=session_id,
        source_tab_id=source_tab_id,
        new_tab_id=new_tab_id,
        cols=cols,
        rows=rows,
        owner_ldap_username=owner,
    )


# ---------------------------------------------------------------------------
# SFTP events
# ---------------------------------------------------------------------------


async def _emit_sftp_error(
    sid: str,
    tab_id: str,
    exc: SFTPError,
    operation: str,
) -> None:
    await sio.emit(
        "sftp:error",
        {
            "tab_id": tab_id,
            "code": exc.code,
            "message": exc.message,
            "operation": operation,
        },
        to=sid,
    )


def _sftp_request_ids(data) -> tuple[str, str]:
    return data.get("session_id", ""), data.get("tab_id", "")


@sio.on("sftp:open")
async def on_sftp_open(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    source_tab_id = data.get("source_tab_id", tab_id)
    if (
        not _valid_id(session_id)
        or not _valid_id(tab_id)
        or not _valid_id(source_tab_id)
    ):
        await sio.emit(
            "sftp:open:result",
            {"tab_id": tab_id, "ok": False, "code": "invalid_request"},
            to=sid,
        )
        return
    if not await _require_auth(sid, tab_id):
        return
    owner = await _owner_for_sid(sid)
    if _ldap_enabled and (
        await ssh_manager.get_session_target(
            session_id, source_tab_id, owner_ldap_username=owner
        )
        is None
    ):
        await sio.emit(
            "sftp:open:result",
            {"tab_id": tab_id, "ok": False, "code": "session_owner_mismatch"},
            to=sid,
        )
        return
    ok = await sftp_manager.open_sftp(
        session_id, tab_id, ssh_manager, source_tab_id=source_tab_id
    )
    if not ok:
        await sio.emit(
            "sftp:open:result",
            {"tab_id": tab_id, "ok": False, "code": "CONNECTION_CLOSED"},
            to=sid,
        )
        return
    try:
        result = await sftp_manager.list_directory(tab_id, ".")
    except SFTPError as exc:
        await sio.emit(
            "sftp:open:result",
            {"tab_id": tab_id, "ok": False, "code": exc.code, "message": exc.message},
            to=sid,
        )
        return

    try:
        target = await ssh_manager.get_session_target(session_id, source_tab_id)
        username = target[2] if target is not None else None
    except Exception:
        logger.warning(
            "Could not determine SFTP username for %s/%s",
            session_id,
            source_tab_id,
            exc_info=True,
        )
        username = None
    try:
        is_root = await ssh_manager.is_root_session(session_id, source_tab_id)
    except Exception:
        logger.warning(
            "Could not determine SFTP root status for %s/%s",
            session_id,
            source_tab_id,
            exc_info=True,
        )
        is_root = False
    await sio.emit(
        "sftp:open:result",
        {"tab_id": tab_id, "username": username, "is_root": is_root, **result},
        to=sid,
    )


@sio.on("sftp:list")
async def on_sftp_list(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        result = await sftp_manager.list_directory(tab_id, data.get("path", "."))
        await sio.emit("sftp:list:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await sio.emit(
            "sftp:list:result",
            {"tab_id": tab_id, "ok": False, "code": exc.code, "message": exc.message},
            to=sid,
        )


@sio.on("sftp:upload")
async def on_sftp_upload(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        raw = base64.b64decode(data.get("data", ""), validate=True)
        if len(raw) >= _SFTP_INLINE_TRANSFER_MAX:
            raise SFTPError(
                "TRANSFER_TOO_LARGE",
                f"Files of {len(raw)} bytes or more must use HTTP upload endpoint /sftp/upload.",
            )
        result = await sftp_manager.upload_file(tab_id, data.get("path", ""), raw)
        await sio.emit("sftp:upload:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc, "upload")
    except Exception:
        await _emit_sftp_error(
            sid,
            tab_id,
            SFTPError(
                "TRANSFER_FAILED", "Transfer failed. Check connection and retry."
            ),
            "upload",
        )


@sio.on("sftp:download")
async def on_sftp_download(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        result = await sftp_manager.download_file(
            tab_id, data.get("path", ""), max_bytes=_SFTP_INLINE_TRANSFER_MAX
        )
        await sio.emit("sftp:download:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc, "download")


@sio.on("sftp:delete")
async def on_sftp_delete(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    paths = (
        data.get("paths")
        if isinstance(data.get("paths"), list)
        else [data.get("path", "")]
    )
    results = []
    for path in paths:
        try:
            results.append(await sftp_manager.delete(tab_id, str(path)))
        except SFTPError as exc:
            results.append(
                {
                    "ok": False,
                    "path": str(path),
                    "code": exc.code,
                    "message": exc.message,
                }
            )
    await sio.emit(
        "sftp:delete:result",
        {
            "tab_id": tab_id,
            "ok": all(item.get("ok") for item in results),
            "results": results,
        },
        to=sid,
    )


@sio.on("sftp:rename")
async def on_sftp_rename(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        result = await sftp_manager.rename(
            tab_id, data.get("old_path", ""), data.get("new_path", "")
        )
        await sio.emit("sftp:rename:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc, "rename")


@sio.on("sftp:mkdir")
async def on_sftp_mkdir(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        result = await sftp_manager.mkdir(tab_id, data.get("path", ""))
        await sio.emit("sftp:mkdir:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc, "mkdir")


@sio.on("sftp:chmod")
async def on_sftp_chmod(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    mode = data.get("mode")
    if isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o7777:
        await sio.emit(
            "sftp:chmod:result",
            {
                "tab_id": tab_id,
                "ok": False,
                "code": "invalid_request",
                "message": "Invalid permission mode.",
            },
            to=sid,
        )
        return
    try:
        result = await sftp_manager.chmod(tab_id, data.get("path", ""), mode)
    except SFTPError as exc:
        await sio.emit(
            "sftp:chmod:result",
            {"tab_id": tab_id, "ok": False, "code": exc.code, "message": exc.message},
            to=sid,
        )
        return
    await sio.emit("sftp:chmod:result", {"tab_id": tab_id, **result}, to=sid)


@sio.on("sftp:chown")
async def on_sftp_chown(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    uid = data.get("uid")
    gid = data.get("gid")
    if (
        isinstance(uid, bool)
        or isinstance(gid, bool)
        or not isinstance(uid, int)
        or not isinstance(gid, int)
        or uid < 0
        or gid < 0
    ):
        await sio.emit(
            "sftp:chown:result",
            {
                "tab_id": tab_id,
                "ok": False,
                "code": "invalid_request",
                "message": "Invalid owner or group id.",
            },
            to=sid,
        )
        return
    try:
        result = await sftp_manager.chown(tab_id, data.get("path", ""), uid, gid)
    except SFTPError as exc:
        await sio.emit(
            "sftp:chown:result",
            {"tab_id": tab_id, "ok": False, "code": exc.code, "message": exc.message},
            to=sid,
        )
        return
    await sio.emit("sftp:chown:result", {"tab_id": tab_id, **result}, to=sid)


@sio.on("sftp:accounts")
async def on_sftp_accounts(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    if await _require_session_owner(sid, session_id, tab_id) is None:
        return
    try:
        result = await sftp_manager.accounts(tab_id)
    except SFTPError as exc:
        await sio.emit(
            "sftp:accounts:result",
            {"tab_id": tab_id, "ok": False, "code": exc.code, "message": exc.message},
            to=sid,
        )
        return
    await sio.emit("sftp:accounts:result", {"tab_id": tab_id, **result}, to=sid)
