"""FastAPI + Socket.IO ASGI application."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from torrus.ssh_manager import SSHManager

logger = logging.getLogger("torrus.server")

_SAFE_ID = re.compile(r'^[a-zA-Z0-9_\-]+$')
_DEV_MODE = bool(os.getenv("TORRUS_DEV"))
_MAX_SESSIONS_PER_SID = 20


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
    ssh_manager.start_background_tasks()
    yield
    await ssh_manager.stop_background_tasks()


fastapi_app = FastAPI(title="torrus", docs_url=None, redoc_url=None, lifespan=lifespan)

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
_auth_lock = asyncio.Lock()

_RATE_LIMIT_WINDOW_SEC = 60
_RATE_LIMIT_MAX = 10
_connection_attempts: dict[str, list[float]] = {}

# Combined ASGI app — uvicorn runs this
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

ssh_manager = SSHManager(sio)


# ---------------------------------------------------------------------------
# Static files + SPA fallback (only when built frontend exists)
# ---------------------------------------------------------------------------

_static = _static_dir()

if _static:
    # Serve /assets/ from Vite build output
    assets_dir = _static / "assets"
    if assets_dir.exists():
        fastapi_app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")


_ldap_config_path = os.getenv("TORRUS_LDAP_CONFIG")
if _ldap_config_path:
    try:
        from ldapgate.config import load_config
        from ldapgate.middleware import add_ldap_auth
    except ImportError as e:
        raise RuntimeError(
            "ldapgate is not installed but TORRUS_LDAP_CONFIG is set. "
            "Install it with: pip install 'torrus[ldap]' or pip install -e /path/to/ldapgate"
        ) from e
    _login_template = Path(__file__).parent / "templates" / "login.html"
    add_ldap_auth(fastapi_app, load_config(_ldap_config_path), template_path=str(_login_template))
    _ldap_enabled = True


@fastapi_app.get("/api/config", include_in_schema=False)
async def api_config():
    return {"ldap_enabled": bool(os.getenv("TORRUS_LDAP_CONFIG"))}


@fastapi_app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    if full_path.lower().startswith("socket.io"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    if _static:
        index = _static / "index.html"
        if index.exists():
            return FileResponse(str(index))
    return JSONResponse(
        status_code=503,
        content={"detail": "Frontend not built. Run: cd frontend && npm run build"},
    )


# ---------------------------------------------------------------------------
# Socket.IO lifecycle
# ---------------------------------------------------------------------------

@sio.on("connect")
async def on_connect(sid, environ):
    remote = environ.get("REMOTE_ADDR", "unknown")
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        remote = forwarded.split(",")[0].strip()
    logger.info("Client connected: %s (from %s)", sid, remote)
    if _ldap_enabled:
        cookies = environ.get("HTTP_COOKIE", environ.get("http_cookie", ""))
        try:
            from ldapgate.session import validate_session_cookie
            if validate_session_cookie(cookies):
                async with _auth_lock:
                    _authenticated_sids.add(sid)
        except ImportError:
            logger.warning("ldapgate session validation not available")
        except Exception:
            logger.warning("LDAP session validation failed", exc_info=True)


@sio.on("disconnect")
async def on_disconnect(sid):
    ssh_manager.unmap_sid(sid)
    async with _auth_lock:
        _authenticated_sids.discard(sid)
    logger.info("Client disconnected: %s", sid)


# ---------------------------------------------------------------------------
# Session registration / recovery
# ---------------------------------------------------------------------------

async def _require_auth(sid: str, tab_id: str) -> bool:
    """Return False and emit an error if LDAP is enabled but the sid is not authenticated."""
    if _ldap_enabled:
        async with _auth_lock:
            authenticated = sid in _authenticated_sids
        if not authenticated:
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
    if _is_private_host(host):
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
    await ssh_manager.disconnect_session(session_id, tab_id)


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



