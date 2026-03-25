"""FastAPI + Socket.IO ASGI application."""

from __future__ import annotations

import logging
import os
import re
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


def _safe_int(value, default: int) -> int:
    """Parse an integer from untrusted input, returning default on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _valid_id(value: str) -> bool:
    """Check that an ID contains only safe characters."""
    return bool(value and _SAFE_ID.match(value))


def _static_dir() -> Path | None:
    try:
        p = Path(str(files("torrus").joinpath("static")))
        return p if p.exists() else None
    except Exception:
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

fastapi_app = FastAPI(title="torrus", docs_url=None, redoc_url=None)

# CORS for Vite dev server
if _DEV_MODE:
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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

    # Serve /fonts/ from Python static dir (JetBrains Mono)
    fonts_dir = _static / "fonts"
    if fonts_dir.exists():
        fastapi_app.mount("/fonts", StaticFiles(directory=str(fonts_dir)), name="fonts")


@fastapi_app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    if full_path.startswith("socket.io"):
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
    logger.info("Client connected: %s (from %s)", sid, remote)


@sio.on("disconnect")
async def on_disconnect(sid):
    ssh_manager.unmap_sid(sid)
    logger.info("Client disconnected: %s", sid)


# ---------------------------------------------------------------------------
# Session registration / recovery
# ---------------------------------------------------------------------------

@sio.on("session:register")
async def on_session_register(sid, data):
    session_id = data.get("session_id", "")
    tab_id = data.get("tab_id", "")
    if not _valid_id(session_id) or not _valid_id(tab_id):
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
    await ssh_manager.handle_input(
        data.get("session_id", ""),
        data.get("tab_id", ""),
        data.get("data", ""),
    )
    return {"ok": True}


@sio.on("terminal:resize")
async def on_terminal_resize(sid, data):
    await ssh_manager.handle_resize(
        data.get("session_id", ""),
        data.get("tab_id", ""),
        _safe_int(data.get("cols", 80), 80),
        _safe_int(data.get("rows", 24), 24),
    )


@sio.on("ssh:disconnect")
async def on_ssh_disconnect(sid, data):
    await ssh_manager.disconnect_session(
        data.get("session_id", ""),
        data.get("tab_id", ""),
    )


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

    await ssh_manager.clone(
        sid=sid,
        session_id=session_id,
        source_tab_id=source_tab_id,
        new_tab_id=new_tab_id,
        cols=cols,
        rows=rows,
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app):
    ssh_manager.start_background_tasks()
    yield


fastapi_app.router.lifespan_context = lifespan
