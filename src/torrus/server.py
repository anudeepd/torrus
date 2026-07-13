"""FastAPI + Socket.IO ASGI application."""

from __future__ import annotations

import asyncio
import base64
from http.cookies import SimpleCookie
import ipaddress
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path
from urllib.parse import quote

import socketio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from torrus import audit_store
from torrus.logging_utils import configure_logging, suppress_routine_polling_logs
from torrus.sftp_manager import SFTPError, SFTPManager
from torrus.ssh_manager import SSHManager

logger = logging.getLogger("torrus.server")

if _log_file := os.getenv("TORRUS_LOG_FILE"):
    configure_logging(Path(_log_file))
else:
    suppress_routine_polling_logs()

_SAFE_ID = re.compile(r'^[a-zA-Z0-9_\-]+$')
_DEV_MODE = bool(os.getenv("TORRUS_DEV"))
_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = os.getenv(
    "TORRUS_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP", "true"
).lower() in {"1", "true", "yes", "on"}
_MAX_SESSIONS_PER_SID = 20
_SFTP_HTTP_UPLOAD_MAX_BYTES = 100 * 1024 * 1024
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
    cors_allowed_origins=(
        ["http://localhost:5173", "http://127.0.0.1:5173"]
        if _DEV_MODE
        else []
    ),
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
    return response

# CORS for Vite dev server
if _DEV_MODE:
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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

# Per-socket/session/tab input buffers for command-level audit. A reconnect gets
# a new socket id, so it cannot complete an unfinished command from another
# authenticated browser session.
_input_buffers: dict[tuple[str, str, str], bytearray] = {}
_input_buffer_lock = asyncio.Lock()
_MAX_INPUT_BUFFER = 1_048_576

# Combined ASGI app — uvicorn runs this
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

sftp_manager = SFTPManager()
ssh_manager = SSHManager(sio, on_disconnect=sftp_manager.on_ssh_disconnect)


# ---------------------------------------------------------------------------
# Static files + SPA fallback (only when built frontend exists)
# ---------------------------------------------------------------------------

_static = _static_dir()

if _static:
    # Serve /assets/ from Vite build output
    assets_dir = _static / "assets"
    if assets_dir.exists():
        fastapi_app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")


def _ensure_ldapgate_static_paths(config) -> None:
    """Allow login-page assets to load without exposing the SPA bundle."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if getattr(proxy_config, "session_cookie_name", "ldapgate_session") == "ldapgate_session":
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
    _ldap_session_manager = add_ldap_auth(fastapi_app, _ldap_config, template_path=str(_login_template))
    if _ldap_session_manager is None:
        logger.warning("ldapgate.add_ldap_auth did not return a SessionManager; using compatibility fallback")
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
async def api_config():
    return {"ldap_enabled": bool(os.getenv("TORRUS_LDAP_CONFIG"))}


@fastapi_app.post("/sftp/upload", include_in_schema=False)
async def sftp_stream_upload(request: Request):
    session_id = request.query_params.get("session_id", "")
    tab_id = request.query_params.get("tab_id", "")
    remote_path = request.query_params.get("path", "")
    if not _valid_id(session_id) or not _valid_id(tab_id) or not remote_path:
        return JSONResponse(status_code=400, content={"ok": False, "code": "invalid_request"})
    if not await ssh_manager.has_session(session_id):
        return JSONResponse(status_code=403, content={"ok": False, "code": "auth_required"})
    try:
        result = await sftp_manager.stream_upload(
            tab_id,
            remote_path,
            request.stream(),
            max_bytes=_SFTP_HTTP_UPLOAD_MAX_BYTES,
            expected_session_id=session_id,
        )
        return JSONResponse(content=result)
    except SFTPError as exc:
        return JSONResponse(
            status_code=404 if exc.code == "FILE_NOT_FOUND" else 413 if exc.code == "FILE_TOO_LARGE" else 403 if exc.code == "PERMISSION_DENIED" else 400,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )


@fastapi_app.get("/sftp/download", include_in_schema=False)
async def sftp_stream_download(request: Request):
    session_id = request.query_params.get("session_id", "")
    tab_id = request.query_params.get("tab_id", "")
    remote_path = request.query_params.get("path", "")
    if not _valid_id(session_id) or not _valid_id(tab_id) or not remote_path:
        return JSONResponse(status_code=400, content={"ok": False, "code": "invalid_request"})
    if not await ssh_manager.has_session(session_id):
        return JSONResponse(status_code=403, content={"ok": False, "code": "auth_required"})

    try:
        download = await sftp_manager.prepare_download(tab_id, remote_path, expected_session_id=session_id)
    except SFTPError as exc:
        return JSONResponse(
            status_code=404 if exc.code == "FILE_NOT_FOUND" else 403 if exc.code == "PERMISSION_DENIED" else 400,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )

    filename = download["name"] or Path(remote_path).name or "download"
    return StreamingResponse(
        sftp_manager.stream_download(tab_id, download["path"], expected_session_id=session_id),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
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

@sio.on("connect")
async def on_connect(sid, environ):
    remote = _direct_client_ip_from_environ(environ)
    forwarded = _header_from_environ(environ, "x-forwarded-for")
    if forwarded:
        remote = forwarded.split(",")[0].strip()
    logger.info("Client connected: %s (from %s)", sid, remote)
    if _ldap_enabled:
        try:
            username = _verify_ldap_socket_session(environ)
            if username:
                async with _auth_lock:
                    _authenticated_sids.add(sid)
                    _authenticated_users[sid] = username
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
        if not authenticated:
            await ssh_manager.unmap_sid(sid)
            async with _auth_lock:
                _authenticated_sids.discard(sid)
                _authenticated_users.pop(sid, None)
            logger.info("Blocking unauthenticated socket event for sid=%s tab=%s", sid, tab_id)
            await sio.emit(
                "ssh:error",
                {"tab_id": tab_id, "message": "Authentication required.", "code": "auth_required"},
                to=sid,
            )
            return False
    return True


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
    # Force shell redraw AFTER session:restored so the frontend clears the
    # viewport first, then the fresh prompt from SIGWINCH overwrites it.
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
    attempts = _connection_attempts.get(sid, [])
    attempts = [t for t in attempts if now - t < _RATE_LIMIT_WINDOW_SEC]
    if len(attempts) >= _RATE_LIMIT_MAX:
        await sio.emit(
            "ssh:error",
            {"tab_id": tab_id, "message": "Too many connection attempts. Please wait.", "code": "rate_limited"},
            to=sid,
        )
        return False
    attempts.append(now)
    _connection_attempts[sid] = attempts
    return True


@sio.on("ssh:connect")
async def on_ssh_connect(sid, data):
    host = data.get("host", "").strip()
    port = _safe_int(data.get("port", 22), 22)
    username = data.get("username", "").strip()
    password = data.get("password", "")
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    cols = _safe_int(data.get("cols", 220), 220)
    rows = _safe_int(data.get("rows", 50), 50)

    if not host or not username or not _valid_id(session_id) or not _valid_id(tab_id):
        await sio.emit(
            "ssh:error",
            {"tab_id": tab_id, "message": "Missing required fields.", "code": "invalid_request"},
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
            {"tab_id": tab_id, "message": "Too many active sessions.", "code": "session_limit"},
            to=sid,
        )
        return
    # LDAP-gated deployments commonly connect to internal hosts or localhost.
    # Operators can disable this in unauthenticated mode by setting
    # TORRUS_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP=false.
    if _is_private_host(host) and not _ldap_enabled and not _ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP:
        logger.warning("Blocked connection to private host %s from sid %s", host, sid)
        await sio.emit(
            "ssh:error",
            {"tab_id": tab_id, "message": "Connections to private/local addresses are not allowed.", "code": "private_host_blocked"},
            to=sid,
        )
        return
    await ssh_manager.connect(
        sid=sid,
        session_id=session_id,
        tab_id=tab_id,
        host=host,
        port=port,
        username=username,
        password=password,
        cols=cols,
        rows=rows,
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
        for sep in (b'\r\n', b'\n', b'\r'):
            i = buffer.find(sep)
            if i != -1 and (idx == -1 or i < idx):
                idx = i
                sep_len = len(sep)

        if idx == -1:
            break

        cmd_bytes = buffer[:idx]
        del buffer[:idx + sep_len]

        cmd_text = cmd_bytes.decode("utf-8", errors="replace")
        cleaned = audit_store.strip_escape(cmd_text).strip()
        if cleaned:
            commands.append(cleaned)

    return commands


@sio.on("ssh:input")
async def on_ssh_input(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    input_data = data.get("data", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return {"ok": False, "error": "Invalid session or tab ID."}
    if not await _require_auth(sid, tab_id):
        return {"ok": False, "error": "Authentication required."}
    if isinstance(input_data, str) and len(input_data) > 1_048_576:
        return {"ok": False, "error": "Input too large."}
    # Buffer input and record complete commands (lines delimited by Enter).
    if _ldap_enabled and isinstance(input_data, (str, bytes)):
        async with _auth_lock:
            ldap_username = _authenticated_users.get(sid)
        if ldap_username:
            target = await ssh_manager.get_session_target(session_id, tab_id)
            ssh_host, ssh_port, ssh_username = target or (None, None, None)

            raw = input_data.encode("utf-8", errors="replace") if isinstance(input_data, str) else input_data

            async with _input_buffer_lock:
                key = (sid, session_id, tab_id)
                if key not in _input_buffers:
                    _input_buffers[key] = bytearray()
                buf = _input_buffers[key]

                if len(buf) + len(raw) > _MAX_INPUT_BUFFER:
                    buf.clear()

                commands = _extract_commands(buf, raw)

            for cmd in commands:
                try:
                    await audit_store.record_command_event(
                        ldap_username=ldap_username,
                        session_id=session_id,
                        tab_id=tab_id,
                        command=cmd,
                        ssh_host=ssh_host,
                        ssh_port=ssh_port,
                        ssh_username=ssh_username,
                    )
                except Exception:
                    logger.exception("Failed to record command audit event")
    await ssh_manager.handle_input(session_id, tab_id, input_data)
    return {"ok": True}


@sio.on("terminal:resize")
async def on_terminal_resize(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    await ssh_manager.handle_resize(
        session_id,
        tab_id,
        _safe_int(data.get("cols", 80), 80),
        _safe_int(data.get("rows", 24), 24),
    )


@sio.on("ssh:disconnect")
async def on_ssh_disconnect(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    await sftp_manager.close_sftp(tab_id)
    await ssh_manager.disconnect_session(session_id, tab_id)
    async with _input_buffer_lock:
        _input_buffers.pop((sid, session_id, tab_id), None)


@sio.on("ssh:clone")
async def on_ssh_clone(sid, data):
    session_id = data.get("session_id", "")
    source_tab_id = data.get("source_tab_id", "")
    new_tab_id = data.get("new_tab_id", "")
    cols = _safe_int(data.get("cols", 220), 220)
    rows = _safe_int(data.get("rows", 50), 50)

    if not _valid_id(session_id) or not _valid_id(source_tab_id) or not _valid_id(new_tab_id):
        await sio.emit(
            "ssh:error",
            {"tab_id": new_tab_id, "message": "Missing required fields.", "code": "invalid_request"},
            to=sid,
        )
        return
    if not await _require_auth(sid, new_tab_id):
        return
    if ssh_manager.sid_session_count(sid) >= _MAX_SESSIONS_PER_SID:
        await sio.emit(
            "ssh:error",
            {"tab_id": new_tab_id, "message": "Too many active sessions.", "code": "session_limit"},
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
    )


# ---------------------------------------------------------------------------
# SFTP events
# ---------------------------------------------------------------------------

async def _emit_sftp_error(sid: str, tab_id: str, exc: SFTPError) -> None:
    await sio.emit(
        "sftp:error",
        {"tab_id": tab_id, "code": exc.code, "message": exc.message},
        to=sid,
    )


def _sftp_request_ids(data) -> tuple[str, str]:
    return data.get("session_id", ""), data.get("tab_id", "")


@sio.on("sftp:open")
async def on_sftp_open(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    source_tab_id = data.get("source_tab_id", tab_id)
    if not _valid_id(session_id) or not _valid_id(tab_id) or not _valid_id(source_tab_id):
        await sio.emit("sftp:open:result", {"tab_id": tab_id, "ok": False, "code": "invalid_request"}, to=sid)
        return
    if not await _require_auth(sid, tab_id):
        return
    ok = await sftp_manager.open_sftp(session_id, tab_id, ssh_manager, source_tab_id=source_tab_id)
    if not ok:
        await sio.emit(
            "sftp:open:result",
            {"tab_id": tab_id, "ok": False, "code": "CONNECTION_CLOSED"},
            to=sid,
        )
        return
    try:
        result = await sftp_manager.list_directory(tab_id, ".")
        await sio.emit("sftp:open:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)


@sio.on("sftp:list")
async def on_sftp_list(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    try:
        result = await sftp_manager.list_directory(tab_id, data.get("path", "."))
        await sio.emit("sftp:list:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)


@sio.on("sftp:upload")
async def on_sftp_upload(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    try:
        raw = base64.b64decode(data.get("data", ""), validate=True)
        result = await sftp_manager.upload_file(tab_id, data.get("path", ""), raw)
        await sio.emit("sftp:upload:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)
    except Exception:
        await _emit_sftp_error(sid, tab_id, SFTPError("TRANSFER_FAILED", "Transfer failed. Check connection and retry."))


@sio.on("sftp:download")
async def on_sftp_download(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    try:
        result = await sftp_manager.download_file(tab_id, data.get("path", ""))
        await sio.emit("sftp:download:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)


@sio.on("sftp:delete")
async def on_sftp_delete(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    paths = data.get("paths") if isinstance(data.get("paths"), list) else [data.get("path", "")]
    results = []
    for path in paths:
        try:
            results.append(await sftp_manager.delete(tab_id, str(path)))
        except SFTPError as exc:
            results.append({"ok": False, "path": str(path), "code": exc.code, "message": exc.message})
    await sio.emit(
        "sftp:delete:result",
        {"tab_id": tab_id, "ok": all(item.get("ok") for item in results), "results": results},
        to=sid,
    )


@sio.on("sftp:rename")
async def on_sftp_rename(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    try:
        result = await sftp_manager.rename(tab_id, data.get("old_path", ""), data.get("new_path", ""))
        await sio.emit("sftp:rename:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)


@sio.on("sftp:mkdir")
async def on_sftp_mkdir(sid, data):
    session_id, tab_id = _sftp_request_ids(data)
    if not _valid_id(session_id) or not _valid_id(tab_id):
        return
    if not await _require_auth(sid, tab_id):
        return
    try:
        result = await sftp_manager.mkdir(tab_id, data.get("path", ""))
        await sio.emit("sftp:mkdir:result", {"tab_id": tab_id, **result}, to=sid)
    except SFTPError as exc:
        await _emit_sftp_error(sid, tab_id, exc)
