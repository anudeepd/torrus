"""Coverage for server wiring, HTTP guards, admin actions, and socket handlers."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from torrus import server
from torrus.admin_state import PolicyError
from torrus.sftp_manager import SFTPError


def request_for(
    path: str = "/",
    *,
    query: dict | None = None,
    headers: dict | None = None,
    cookies: dict | None = None,
    body=None,
):
    request = MagicMock(spec=Request)
    request.url = SimpleNamespace(path=path)
    request.scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": b"",
        "headers": [
            (name.lower().encode(), str(value).encode())
            for name, value in (headers or {}).items()
        ],
        "client": ("192.0.2.10", 1234),
        "server": ("testserver", 80),
        "scheme": "http",
    }
    request.headers = headers or {}
    request.cookies = cookies or {}
    request.query_params = query or {}
    request.client = SimpleNamespace(host="192.0.2.10")
    request.json = AsyncMock(return_value=body if body is not None else {})
    request.state = SimpleNamespace(csp_style_nonce="test-nonce")
    return request


def error_code(response: JSONResponse) -> str:
    return json.loads(response.body)["code"]


def test_env_flag_safe_int_and_static_helpers(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_FLAG_TEST", "YES")
    assert server._env_flag("TORRUS_FLAG_TEST", False) is True
    monkeypatch.delenv("TORRUS_FLAG_TEST")
    assert server._env_flag("TORRUS_FLAG_TEST", True) is True
    assert server._safe_int(None, 7) == 7
    assert server._safe_int(object(), 9) == 9
    assert server._safe_int("bad", 11) == 11

    monkeypatch.setattr(server, "files", MagicMock(side_effect=TypeError("bad")))
    assert server._static_dir() is None
    monkeypatch.setattr(server, "files", MagicMock(side_effect=RuntimeError("bad")))
    assert server._static_dir() is None
    assert error_code(server._frontend_unbuilt_response()) == "frontend_unbuilt"

    static = tmp_path / "static"
    static.mkdir()
    monkeypatch.setattr(server, "_static", static)
    assert asyncio.run(server._root_static_file("missing", "text/plain")).status_code == 404


@pytest.mark.asyncio
async def test_lifespan_initializes_audit_for_ldap(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server.audit_store, "init_db", MagicMock())
    monkeypatch.setattr(server.ssh_manager, "start_background_tasks", MagicMock())
    monkeypatch.setattr(server.ssh_manager, "stop_background_tasks", AsyncMock())
    monkeypatch.setattr(server.upload_store, "close", AsyncMock())
    monkeypatch.setattr(server.sftp_manager, "shutdown", AsyncMock())
    async with server.lifespan(None):
        pass
    server.audit_store.init_db.assert_called_once()


@pytest.mark.asyncio
async def test_upload_sweeper_logs_reclamation_and_survives_failure(monkeypatch):
    sleeps = AsyncMock(side_effect=[None, None, None, asyncio.CancelledError()])
    monkeypatch.setattr(server.asyncio, "sleep", sleeps)
    monkeypatch.setattr(
        server.upload_store,
        "sweep",
        AsyncMock(side_effect=[2, 0, RuntimeError("sweep failed")]),
    )
    with pytest.raises(asyncio.CancelledError):
        await server._sweep_upload_sessions()
    assert server.upload_store.sweep.await_count == 3


def test_static_endpoints_and_spa_fallback(monkeypatch, tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "favicon.svg").write_text("icon")
    (static / "apple-touch-icon.png").write_bytes(b"png")
    (static / "manifest.webmanifest").write_text("{}")
    (static / "index.html").write_text("index")
    monkeypatch.setattr(server, "_static", static)

    asyncio.run(server.favicon())
    asyncio.run(server.apple_touch_icon())
    asyncio.run(server.web_manifest())
    assert asyncio.run(server.spa_fallback("socket.io", request_for())).status_code == 404
    assert asyncio.run(server.spa_fallback("", request_for())).status_code == 200

    monkeypatch.setattr(server, "_static", None)
    assert asyncio.run(server.spa_fallback("", request_for())).status_code == 503


@pytest.mark.asyncio
async def test_http_and_validation_exception_envelopes():
    response = await server._http_exception_envelope(
        MagicMock(),
        StarletteHTTPException(
            status_code=403, detail="auth_required", headers={"WWW-Authenticate": "x"}
        ),
    )
    assert error_code(response) == "auth_required"
    assert response.headers["WWW-Authenticate"] == "x"

    response = await server._http_exception_envelope(
        MagicMock(), StarletteHTTPException(status_code=418, detail="teapot")
    )
    assert response.status_code == 418
    response = await server._http_exception_envelope(
        MagicMock(), StarletteHTTPException(status_code=422, detail=["bad"])
    )
    assert error_code(response) == "invalid_request"

    error = RequestValidationError([{"loc": ("body",), "msg": "bad", "type": "value_error"}])
    response = await server._validation_exception_envelope(MagicMock(), error)
    assert response.status_code == 422
    assert error_code(response) == "invalid_request"


@pytest.mark.asyncio
async def test_admin_paths_get_no_store_and_vary_headers():
    response = Response()

    async def call_next(_request):
        return response

    result = await server.add_app_security_headers(
        request_for("/api/admin/users"), call_next
    )
    assert result.headers["Cache-Control"] == "no-store"
    assert result.headers["Vary"] == "Cookie"

    asset_response = Response()

    async def asset_call_next(_request):
        return asset_response

    assets = await server.add_app_security_headers(
        request_for("/assets/app.js"), asset_call_next
    )
    assert assets.headers["Cache-Control"] == server.HASHED_ASSET_CACHE_CONTROL


def test_completion_edits_and_command_buffer_edges():
    assert server._apply_completion_edits("abc", 3, "\rX") == ("Xbc", 1)
    assert server._apply_completion_edits("abc", 3, "\nX") == ("X", 1)
    assert server._apply_completion_edits("abc", 2, "\t") == ("abc", 2)
    assert server._apply_completion_edits("abc", 2, "\b") == ("abc", 1)

    buffer = server._CommandInputBuffer()
    try:
        buffer._append(b"")
        buffer.overflowed = True
        buffer._append(b"x")
        buffer.overflowed = False
        buffer.size = server._INPUT_BUFFER_MAX_BYTES
        buffer._append(b"x")
        assert buffer.overflowed is True

        buffer._replace("x" * (server._INPUT_BUFFER_MAX_BYTES + 1))
        assert buffer.overflowed is True
        assert buffer.size == server._INPUT_BUFFER_MAX_BYTES

        buffer._reset()
        buffer.size = server._INPUT_BUFFER_MAX_BYTES - 1
        buffer._append(b"xy")
        assert buffer.overflowed is True

        buffer.completion_zone_start = 2
        buffer._replace("x")
        assert buffer.completion_zone_start == 1
        assert buffer._line_from_redraw("", "x") is None
        assert buffer._line_from_redraw("needle", "haystack") is None
        assert buffer._line_from_redraw("needle", "a needle") == "needle"
        assert buffer._line_from_edits("ABC", "", "abcd") == "abcd"
        assert buffer._line_from_edits("ABC", "zone", "ABCmore") == "ABCmore"
        assert buffer._line_from_edits("ABC", "zone", "abcdef") == "abcdefe"
        assert buffer._line_from_edits("", "zone", "zoney") == "zoney"

        buffer.completion_pending = True
        buffer.size = 0
        buffer.observe_output(b"\x1b[31m")
        buffer.completion_pending = False
        buffer.observe_output(b"x")
        buffer.completion_pending = True
        buffer._replace("prompt")
        buffer.observe_output(b"prompt\rnext")
        buffer.completion_pending = True
        buffer.observe_output(b"promptx")
        assert list(buffer._filtered_input(b"\x1b[200~x\x1b[201~")) == [
            (120, True)
        ]
        buffer._filtered_input(b"\x1b[")
        buffer._filtered_input(b"")
        buffer.extract(b"abc\tdef\r")
        buffer.extract(b"")
        buffer.overflowed = True
        assert buffer.extract(b"x\r") == [server._OVERSIZED_INPUT_MARKER]
    finally:
        buffer.close()

    class NoClose:
        pass

    server._close_command_buffer(NoClose())


def test_sensitive_buffer_skips_the_lf_after_cr():
    buffer = server._SensitiveInputBuffer()
    assert buffer.count_lines(b"\r\n\r") == 2
    assert buffer.count_lines(b"\rX") == 1
    assert server._SensitiveInputBuffer().count_lines(b"\n") == 1


def test_ldapgate_static_paths_and_cookie_helpers(monkeypatch):
    server._ensure_ldapgate_static_paths(SimpleNamespace(proxy=None))
    proxy = SimpleNamespace(
        session_cookie_name="ldapgate_session",
        static_paths=["/existing"],
    )
    server._ensure_ldapgate_static_paths(SimpleNamespace(proxy=proxy))
    assert proxy.session_cookie_name == "torrus_session"
    assert "/favicon.svg" in proxy.static_paths

    assert server._cookie_from_header("", "x") is None
    assert server._cookie_from_header("x=1", "x") == "1"
    broken = MagicMock()
    broken.load.side_effect = ValueError("bad")
    monkeypatch.setattr(server, "SimpleCookie", lambda: broken)
    assert server._cookie_from_header("bad", "x") is None


@pytest.mark.asyncio
async def test_cleanup_and_output_audit_buffers(monkeypatch):
    command = server._CommandInputBuffer()
    server._input_buffers[("sid", "sess", "tab")] = command
    server._sensitive_input_buffers[("sid", "sess", "tab")] = (
        server._SensitiveInputBuffer()
    )
    close = MagicMock()
    monkeypatch.setattr(server, "_close_command_buffer", close)
    monkeypatch.setattr(
        server.sftp_manager, "on_ssh_tab_disconnect", AsyncMock()
    )
    await server._cleanup_ssh_input_buffer("sess", "tab")
    close.assert_called_once_with(command)
    assert server._sensitive_input_buffers == {}

    command = server._CommandInputBuffer()
    server._input_buffers[("sid", "sess", "tab")] = command
    other = server._CommandInputBuffer()
    server._input_buffers[("sid", "other", "tab")] = other
    try:
        await server._record_ssh_output_audit(
            "sess", "tab", b"Password: "
        )
        assert ("sess", "tab") in server._sensitive_prompt_pending
        assert "Password" in server._output_tails[("sess", "tab")]
    finally:
        command.close()
        other.close()


def test_header_and_client_ip_fallbacks(monkeypatch):
    environ = {
        "HTTP_USER_AGENT": "ua",
        "asgi.scope": {
            "headers": [
                (b"x-bad", b"value"),
                ("not-bytes", b"value"),
                (b"x-ok", b"ok"),
            ],
            "client": ("203.0.113.9", 1),
        },
    }
    assert server._header_from_environ(environ, "user-agent") == "ua"
    assert server._header_from_environ(environ, "x-ok") == "ok"
    assert server._direct_client_ip_from_environ(environ) == "203.0.113.9"

    proxy = SimpleNamespace(
        trusted_proxies=["10.0.0.0/8"],
        session_cookie_name="x",
        secure_cookies=False,
    )
    monkeypatch.setattr(
        server, "_ldap_config", SimpleNamespace(proxy=proxy, ldap=None)
    )
    monkeypatch.setitem(sys.modules, "ldapgate._auth_utils", None)
    assert server._client_ip_from_environ({"REMOTE_ADDR": "10.1.1.1"}) == "10.1.1.1"

    helpers = ModuleType("ldapgate._auth_utils")
    helpers._is_ip_in_networks = lambda ip, networks: ip.startswith("10.")
    monkeypatch.setitem(sys.modules, "ldapgate._auth_utils", helpers)
    assert (
        server._client_ip_from_environ(
            {
                "REMOTE_ADDR": "10.1.1.1",
                "HTTP_X_FORWARDED_FOR": "203.0.113.1, 10.1.1.2",
            }
        )
        == "203.0.113.1"
    )
    assert (
        server._client_ip_from_environ(
            {"REMOTE_ADDR": "10.1.1.1", "HTTP_X_FORWARDED_FOR": "10.1.1.2"}
        )
        == "10.1.1.1"
    )
    assert (
        server._client_ip_from_environ({"REMOTE_ADDR": "203.0.113.2"})
        == "203.0.113.2"
    )


@pytest.mark.asyncio
async def test_admin_guards_and_origins(monkeypatch):
    monkeypatch.setattr(server, "_ADMIN_USERS", {"admin"})
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value=None))
    actor, error = await server._admin_actor(request_for())
    assert actor is None
    assert error.status_code == 401

    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="bob"))
    actor, error = await server._admin_actor(request_for())
    assert error.status_code == 403

    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="admin"))
    assert (await server._admin_actor(request_for()))[0] == "admin"

    monkeypatch.setattr(server, "_ldap_config", None)
    assert server._admin_hosts(request_for(headers={"host": "Example.com"})) == {
        "example.com"
    }
    monkeypatch.setattr(server, "_DEV_MODE", True)
    monkeypatch.setattr(server, "_DEV_ORIGINS", ["http://localhost:5173"])
    assert "localhost:5173" in server._admin_hosts(request_for())

    assert server._admin_origin_allowed(request_for()) is True
    assert server._admin_origin_allowed(request_for(headers={"origin": "null"})) is False
    assert (
        server._admin_origin_allowed(
            request_for(
                headers={"origin": "https://example.com", "host": "example.com"}
            )
        )
        is True
    )
    assert (
        server._admin_origin_allowed(request_for(headers={"origin": "ftp://example.com"}))
        is False
    )

    monkeypatch.setattr(server, "_admin_actor", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_admin_origin_allowed", lambda _request: False)
    _, error = await server._admin_guard(request_for(), mutate=True)
    assert error_code(error) == "trusted_origin_required"


@pytest.mark.asyncio
async def test_admin_csrf_and_guard_branches(monkeypatch):
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="admin"))
    assert await server._admin_csrf_valid(request_for()) is False
    assert (
        await server._admin_csrf_valid(
            request_for(headers={"x-torrus-csrf": "a"}, cookies={"torrus_admin_csrf": "b"})
        )
        is False
    )

    with patch("torrus.server.secrets.compare_digest", return_value=True):
        assert (
            await server._admin_csrf_valid(
                request_for(
                    headers={"x-torrus-csrf": "token"},
                    cookies={"torrus_admin_csrf": "token"},
                )
            )
            is False
        )
        server._admin_csrf_tokens["token"] = ("admin", 0)
        assert (
            await server._admin_csrf_valid(
                request_for(
                    headers={"x-torrus-csrf": "token"},
                    cookies={"torrus_admin_csrf": "token"},
                )
            )
            is False
        )
        server._admin_csrf_tokens["token"] = ("admin", server.time.time() + 60)
        assert (
            await server._admin_csrf_valid(
                request_for(
                    headers={"x-torrus-csrf": "token"},
                    cookies={"torrus_admin_csrf": "token"},
                )
            )
            is True
        )
    server._admin_csrf_tokens.pop("token", None)

    monkeypatch.setattr(
        server, "_admin_actor", AsyncMock(return_value=(None, JSONResponse({}, 401)))
    )
    actor, error = await server._admin_guard(request_for())
    assert actor is None
    assert error.status_code == 401

    monkeypatch.setattr(
        server, "_admin_actor", AsyncMock(return_value=("admin", None))
    )
    monkeypatch.setattr(server, "_ldap_enabled", True)
    actor, error = await server._admin_guard(request_for(), mutate=True)
    assert error.status_code == 403
    assert error_code(error) == "csrf_required"


@pytest.mark.asyncio
async def test_admin_action_helpers(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", True)
    _, _, error = await server._begin_admin_action(
        request_for(headers={}), "admin", "edit", "target"
    )
    assert error.status_code == 400

    response = server._replayed_action({"action_id": "a", "status": "pending"})
    assert response.status_code == 202
    response = server._replayed_action(
        {"action_id": "a", "status": "succeeded", "result": {"ok": True}}
    )
    assert response.status_code == 200
    response = server._replayed_action({"action_id": "a", "status": "failed"})
    assert response.status_code == 409

    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_admin_sids", {"sid"})
    await server._emit_admin_event("test", {"value": 1})
    sio.emit.assert_awaited_once()

    monkeypatch.setattr(
        server, "_finish_admin_action", AsyncMock(return_value={"action_id": "a"})
    )
    response = await server._admin_action_response(
        {"action_id": "a"}, status="failed", result={"ok": False}, event_kind="test"
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_admin_http_routes_cover_guards_and_not_found(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    assert (await server.admin_csrf(request_for())).status_code == 200

    monkeypatch.setattr(server, "_static", None)
    assert (await server.admin_shell(request_for())).status_code == 503
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("index")
    monkeypatch.setattr(server, "_static", static)
    assert (await server.admin_shell(request_for())).status_code == 200

    assert (
        await server.admin_action_status("bad/id", request_for())
    ).status_code == 400
    monkeypatch.setattr(server.audit_store, "get_admin_action", MagicMock(return_value=None))
    assert (await server.admin_action_status("good", request_for())).status_code == 404
    monkeypatch.setattr(
        server.audit_store,
        "get_admin_action",
        MagicMock(return_value={"actor": "admin", "action_id": "good"}),
    )
    assert (await server.admin_action_status("good", request_for()))["ok"] is True

    error = JSONResponse({"ok": False}, status_code=401)
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=(None, error)))
    assert (await server.admin_csrf(request_for())).status_code == 401
    assert (await server.admin_shell(request_for())).status_code == 401
    assert (await server.admin_action_status("good", request_for())).status_code == 401
    assert (await server.admin_policy(request_for())).status_code == 401

    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setattr(server, "_static", empty)
    assert (await server.admin_shell(request_for())).status_code == 503

    expired = "expired"
    server._admin_csrf_tokens[expired] = ("admin", 0)
    await server.admin_csrf(request_for())
    assert expired not in server._admin_csrf_tokens


@pytest.mark.asyncio
async def test_admin_policy_snapshot_errors_and_values(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server, "_ldap_config_path", "/tmp/ldap.yaml")
    monkeypatch.setattr(
        server.LDAPPolicyStore,
        "snapshot",
        MagicMock(side_effect=PolicyError("bad")),
    )
    assert (await server.admin_policy(request_for())).status_code == 503
    monkeypatch.setattr(
        server.LDAPPolicyStore,
        "snapshot",
        MagicMock(
            return_value={"fingerprint": "f", "allowed_users": ["alice"]}
        ),
    )
    result = await server.admin_policy(request_for())
    assert result["fingerprint"] == "f"


def test_admin_session_page_invalid_cursor():
    page, cursor = server._admin_session_page([{"id": 1}], 1, "not-an-int")
    assert page == [{"id": 1}]
    assert cursor is None


@pytest.mark.asyncio
async def test_admin_listing_error_branches(monkeypatch):
    error = JSONResponse({"ok": False}, status_code=401)
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=(None, error)))
    for handler in (
        server.admin_users,
        server.admin_sessions,
        server.admin_activity,
        server.admin_retention,
        server.admin_interrupt,
        server.admin_kick,
        server.admin_add_user,
        server.admin_disable_user,
        server.admin_enable_user,
        server.admin_purge,
    ):
        if handler in {server.admin_interrupt, server.admin_kick}:
            response = await handler("session", request_for())
        elif handler in {server.admin_disable_user, server.admin_enable_user}:
            response = await handler("bob", request_for())
        else:
            response = await handler(request_for())
        assert response.status_code == 401


@pytest.mark.asyncio
async def test_admin_sessions_and_activity_parse_invalid_limits(monkeypatch, tmp_path):
    monkeypatch.setenv("TORRUS_AUDIT_DB", str(tmp_path / "audit.db"))
    server.audit_store.init_db()
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server.ssh_manager, "list_sessions", AsyncMock(return_value=[]))
    result = await server.admin_sessions(
        request_for(query={"limit": "bad", "cursor": "bad"})
    )
    assert result["items"] == []
    result = await server.admin_activity(request_for(query={"limit": "bad"}))
    assert result["items"] == []
    result = await server.admin_retention(
        request_for(query={"older_than_days": "bad"})
    )
    assert result["cutoff_days"] == 30


@pytest.mark.asyncio
async def test_admin_users_merges_policy_and_session_owners(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(
        server,
        "_ldap_config",
        SimpleNamespace(ldap=SimpleNamespace(allowed_users=["Alice", "", "bob"])),
    )
    monkeypatch.setattr(
        server.ssh_manager,
        "list_sessions",
        AsyncMock(
            return_value=[
                {"owner_ldap_username": "Alice"},
                {"owner_ldap_username": ""},
            ]
        ),
    )
    monkeypatch.setattr(server, "_PENDING_DISABLED_USERS", {"carol"})
    result = await server.admin_users(request_for())
    assert [item["username"] for item in result["items"]] == ["alice", "bob", "carol"]
    assert result["items"][0]["active_sessions"] == 1
    assert result["items"][2]["policy_state"] == "disabled"


@pytest.mark.asyncio
async def test_admin_interrupt_and_kick_outcomes(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a"}, False, None)),
    )
    monkeypatch.setattr(
        server,
        "_admin_action_response",
        AsyncMock(side_effect=lambda _record, **kwargs: kwargs["result"]),
    )
    monkeypatch.setattr(
        server.ssh_manager, "interrupt_session", AsyncMock(return_value="queued")
    )
    result = await server.admin_interrupt("session", request_for(body={"generation": 2}))
    assert result["ok"] is True

    monkeypatch.setattr(
        server.ssh_manager, "terminate_session", AsyncMock(return_value="unknown")
    )
    result = await server.admin_kick("session", request_for(body={"generation": 2}))
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_admin_interrupt_and_kick_validate_and_replay(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    for handler in (server.admin_interrupt, server.admin_kick):
        response = await handler("session", request_for(body={"generation": "bad"}))
        assert response.status_code == 400
        monkeypatch.setattr(
            server,
            "_begin_admin_action",
            AsyncMock(
                return_value=(
                    {"action_id": "a", "status": "succeeded", "result": {"ok": True}},
                    True,
                    None,
                )
            ),
        )
        response = await handler("session", request_for(body={"generation": 1}))
        assert response.status_code == 200

        monkeypatch.setattr(
            server,
            "_begin_admin_action",
            AsyncMock(return_value=(None, False, JSONResponse({}, status_code=400))),
        )
        response = await handler("session", request_for(body={"generation": 1}))
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_policy_mutation_and_live_allowlist(monkeypatch):
    monkeypatch.setattr(server, "_ldap_config_path", None)
    assert (await server._policy_mutation("bob", True, None))["allowed_users"] == []

    mutation = SimpleNamespace(
        fingerprint="f", backup_id="b", allowed_users=["alice"]
    )
    monkeypatch.setattr(server, "_ldap_config_path", "/tmp/ldap.yaml")
    monkeypatch.setattr(server.LDAPPolicyStore, "mutate", MagicMock(return_value=mutation))
    result = await server._policy_mutation("alice", True, "old")
    assert result["backup_id"] == "b"

    ldap = SimpleNamespace(allowed_users=["Alice", "pending", "alice"])
    monkeypatch.setattr(server, "_ldap_config", SimpleNamespace(ldap=ldap))
    monkeypatch.setattr(server, "_PENDING_DISABLED_USERS", {"pending"})
    server._apply_live_ldap_allowlist(["alice", "", "ALICE", "pending", "bob"])
    assert ldap.allowed_users == ["alice", "bob", "pending"]


@pytest.mark.asyncio
async def test_add_user_validation_and_replay(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    response = await server.admin_add_user(request_for(body={"username": ""}))
    assert response.status_code == 400
    monkeypatch.setattr(server, "_ldap_config_path", None)
    response = await server.admin_add_user(request_for(body={"username": "bob"}))
    assert response.status_code == 503
    monkeypatch.setattr(server, "_ldap_config_path", "/tmp/ldap.yaml")
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a", "status": "pending"}, True, None)),
    )
    response = await server.admin_add_user(request_for(body={"username": "bob"}))
    assert response.status_code == 202

    broken = MagicMock()
    broken.json = AsyncMock(side_effect=ValueError("bad"))
    response = await server.admin_add_user(broken)
    assert response.status_code == 400

    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=(None, False, JSONResponse({}, status_code=400))),
    )
    response = await server.admin_add_user(request_for(body={"username": "bob"}))
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_restore_ldap_user_and_enable(monkeypatch):
    monkeypatch.setattr(server, "_ldap_session_manager", object())
    with pytest.raises(RuntimeError, match="restore is unavailable"):
        await server._restore_ldap_user("bob")

    manager = SimpleNamespace(restore_user_sessions=MagicMock())
    monkeypatch.setattr(server, "_ldap_session_manager", manager)
    await server._restore_ldap_user("bob")
    manager.restore_user_sessions.assert_called_once_with("bob")

    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server, "_ldap_config_path", "/tmp/ldap.yaml")
    monkeypatch.setattr(
        server,
        "_policy_mutation",
        AsyncMock(return_value={"fingerprint": "f", "backup_id": "b", "allowed_users": []}),
    )
    monkeypatch.setattr(server, "_restore_ldap_user", AsyncMock())
    monkeypatch.setattr(
        server,
        "_admin_action_response",
        AsyncMock(side_effect=lambda _record, **kwargs: kwargs["result"]),
    )
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a"}, False, None)),
    )
    result = await server.admin_enable_user("bob", request_for())
    assert result["ok"] is True
    assert "bob" not in server._PENDING_DISABLED_USERS


@pytest.mark.asyncio
async def test_disable_rejects_invalid_and_protected_users(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server, "_ADMIN_USERS", {"admin"})
    assert (await server.admin_disable_user("", request_for())).status_code == 400
    response = await server.admin_disable_user("admin", request_for())
    assert response.status_code == 409

    broken = MagicMock()
    broken.json = AsyncMock(side_effect=ValueError("bad"))
    monkeypatch.setattr(server, "_ldap_config_path", "/tmp/ldap.yaml")
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a", "status": "pending"}, True, None)),
    )
    response = await server.admin_disable_user("bob", broken)
    assert response.status_code == 202

    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=(None, False, JSONResponse({}, status_code=400))),
    )
    response = await server.admin_disable_user("bob", request_for())
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_enable_validation_and_error_branches(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    assert (await server.admin_enable_user("", request_for())).status_code == 400
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=(None, False, JSONResponse({}, status_code=400))),
    )
    response = await server.admin_enable_user("bob", request_for())
    assert response.status_code == 400
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a", "status": "pending"}, True, None)),
    )
    response = await server.admin_enable_user("bob", request_for())
    assert response.status_code == 202
    broken = MagicMock()
    broken.json = AsyncMock(side_effect=ValueError("bad"))
    response = await server.admin_enable_user("bob", broken)
    assert response.status_code == 202


@pytest.mark.asyncio
async def test_admin_purge_validation_success_and_replay(monkeypatch):
    monkeypatch.setattr(server, "_admin_guard", AsyncMock(return_value=("admin", None)))
    response = await server.admin_purge(request_for(body={"older_than_days": "bad"}))
    assert response.status_code == 400
    response = await server.admin_purge(
        request_for(body={"older_than_days": 30, "confirmation": "no"})
    )
    assert response.status_code == 400
    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a"}, False, None)),
    )
    monkeypatch.setattr(
        server.audit_store, "purge_audit_events_older_than", MagicMock(return_value=3)
    )
    monkeypatch.setattr(
        server,
        "_admin_action_response",
        AsyncMock(side_effect=lambda _record, **kwargs: kwargs["result"]),
    )
    result = await server.admin_purge(
        request_for(body={"older_than_days": 30, "confirmation": "PURGE"})
    )
    assert result["removed"] == 3

    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=({"action_id": "a", "status": "pending"}, True, None)),
    )
    response = await server.admin_purge(
        request_for(body={"older_than_days": 30, "confirmation": "PURGE"})
    )
    assert response.status_code == 202

    monkeypatch.setattr(
        server,
        "_begin_admin_action",
        AsyncMock(return_value=(None, False, JSONResponse({}, status_code=400))),
    )
    response = await server.admin_purge(
        request_for(body={"older_than_days": 30, "confirmation": "PURGE"})
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_sftp_http_download_guards_and_success(monkeypatch):
    response = await server.sftp_stream_download(
        request_for(query={"session_id": "", "tab_id": "", "path": ""})
    )
    assert response.status_code == 400

    request = request_for(
        query={"session_id": "sess", "tab_id": "tab", "path": "/x"}
    )
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value=None))
    assert (await server.sftp_stream_download(request)).status_code == 401
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="alice"))
    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=False))
    assert (await server.sftp_stream_download(request)).status_code == 403

    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_download",
        AsyncMock(side_effect=SFTPError("FILE_NOT_FOUND", "missing")),
    )
    response = await server.sftp_stream_download(request)
    assert response.status_code == 404

    async def chunks():
        yield b"data"

    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_download",
        AsyncMock(return_value={"name": "", "path": "/x", "size": 4}),
    )
    monkeypatch.setattr(server.sftp_manager, "stream_download", lambda *_a, **_k: chunks())
    monkeypatch.setattr(server, "_record_sftp_events_audit", AsyncMock())
    response = await server.sftp_stream_download(request)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_sftp_http_bulk_guards_and_sftp_failure(monkeypatch):
    bad = MagicMock()
    bad.json = AsyncMock(side_effect=ValueError("bad json"))
    assert (await server.sftp_stream_bulk_download(bad)).status_code == 400

    invalid = await server.sftp_stream_bulk_download(
        request_for(body={"session_id": "sess", "tab_id": "tab", "paths": []})
    )
    assert invalid.status_code == 400

    request = request_for(
        body={"session_id": "sess", "tab_id": "tab", "paths": ["/a"]}
    )
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value=None))
    assert (await server.sftp_stream_bulk_download(request)).status_code == 401
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="alice"))
    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=False))
    assert (await server.sftp_stream_bulk_download(request)).status_code == 403
    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_bulk_download",
        AsyncMock(side_effect=SFTPError("TRANSFER_FAILED", "bad")),
    )
    response = await server.sftp_stream_bulk_download(request)
    assert response.status_code == 400

    async def chunks():
        yield b"zip"

    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_bulk_download",
        AsyncMock(return_value={"files": [("/a", "a", 1)]}),
    )
    monkeypatch.setattr(server.sftp_manager, "stream_bulk_zip", lambda *_a, **_k: chunks())
    monkeypatch.setattr(server, "_record_sftp_events_audit", AsyncMock())
    response = await server.sftp_stream_bulk_download(request)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_admin_socket_subscription_and_unsubscribe(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server, "_verify_ldap_socket_session", AsyncMock(return_value="admin")
    )
    monkeypatch.setattr(server, "_ADMIN_USERS", {"admin"})
    result = await server.on_admin_subscribe("sid", {})
    assert result["ok"] is True
    assert "sid" in server._admin_sids
    sio.emit.assert_awaited_once()
    assert await server.on_admin_unsubscribe("sid") == {"ok": True}

    monkeypatch.setattr(server, "_ldap_enabled", False)
    assert await server.on_admin_subscribe("other", {}) == {
        "ok": False,
        "code": "admin_required",
    }


@pytest.mark.asyncio
async def test_connect_logs_ldap_verification_failures(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server,
        "_verify_ldap_socket_session",
        AsyncMock(side_effect=RuntimeError("bad cookie")),
    )
    await server.on_connect("sid", {"REMOTE_ADDR": "192.0.2.1"})
    assert server._sid_client_ips["sid"] == "192.0.2.1"


@pytest.mark.asyncio
async def test_session_owner_and_sftp_ownership_helpers(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", False)
    assert await server._require_session_owner("sid", "sess", "tab") == ""

    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_authenticated_users", {"sid": "alice"})
    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=None)
    )
    assert await server._require_session_owner("sid", "sess", "tab") is None
    assert sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"

    monkeypatch.setattr(server.sftp_manager, "get_source_tab_id", MagicMock(return_value=None))
    assert await server._sftp_session_owned("sess", "tab", "alice") is False
    monkeypatch.setattr(
        server.sftp_manager, "get_source_tab_id", MagicMock(return_value="source")
    )
    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=("h", 22, "u"))
    )
    assert await server._sftp_session_owned("sess", "tab", "alice") is True

    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=("h", 22, "u"))
    )
    assert await server._require_session_owner("sid", "sess", "tab") == "alice"


@pytest.mark.asyncio
async def test_http_owner_and_session_register_blocked(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", False)
    assert await server._http_owner(request_for()) is None
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server, "_verify_ldap_socket_session", AsyncMock(return_value="alice")
    )
    assert await server._http_owner(request_for()) == "alice"

    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server.ssh_manager, "restore_session", AsyncMock())
    await server.on_session_register(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )
    server.ssh_manager.restore_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_rate_limit_sweeps_expired_buckets(monkeypatch):
    monkeypatch.setattr(server, "_connection_attempts", {"old": [0]})
    monkeypatch.setattr(server, "_sid_client_ips", {"sid": "192.0.2.2"})
    assert await server._check_rate_limit("sid", "tab") is True
    assert "old" not in server._connection_attempts


@pytest.mark.asyncio
async def test_ssh_connect_rejects_invalid_and_rate_limited(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    await server.on_ssh_connect(
        "sid",
        {
            "host": "",
            "port": 22,
            "username": "",
            "password": "x",
            "session_id": "bad/id",
            "tab_id": "tab",
        },
    )
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"

    await server.on_ssh_connect(
        "sid",
        {
            "host": "example.com",
            "port": 22,
            "username": "alice",
            "password": None,
            "session_id": "sess",
            "tab_id": "tab",
        },
    )
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"

    monkeypatch.setattr(server, "_check_rate_limit", AsyncMock(return_value=False))
    await server.on_ssh_connect(
        "sid",
        {
            "host": "example.com",
            "port": 22,
            "username": "alice",
            "password": "x",
            "session_id": "sess",
            "tab_id": "tab",
        },
    )
    assert sio.emit.await_args.args[0] == "ssh:error"


@pytest.mark.asyncio
async def test_input_audit_closes_previous_buffer_and_logs_failures(monkeypatch):
    previous = MagicMock()
    server._input_buffers[("sid", "sess", "tab")] = previous
    server._sensitive_prompt_pending.add(("sess", "tab"))
    monkeypatch.setattr(
        server.audit_store,
        "record_sensitive_event",
        MagicMock(side_effect=RuntimeError("audit down")),
    )
    await server._record_ssh_input_audit(
        sid="sid",
        session_id="sess",
        tab_id="tab",
        input_data=b"secret\r",
        target=("host", 22, "root"),
        owner="alice",
        sensitive=False,
    )
    previous.close.assert_called_once()
    assert ("sid", "sess", "tab") not in server._input_buffers

    monkeypatch.setattr(
        server.audit_store,
        "record_sensitive_event",
        MagicMock(side_effect=RuntimeError("audit down")),
    )
    await server._record_ssh_input_audit(
        sid="sid",
        session_id="sess",
        tab_id="other",
        input_data=b"token=abc\r",
        target=("host", 22, "root"),
        owner="alice",
        sensitive=False,
    )


@pytest.mark.asyncio
async def test_ssh_input_rejects_a_missing_target(monkeypatch):
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=None)
    )
    result = await server.on_ssh_input(
        "sid", {"session_id": "sess", "tab_id": "tab", "data": "x"}
    )
    assert result["code"] == "session_owner_mismatch"


@pytest.mark.asyncio
async def test_ssh_input_returns_rejection_and_supports_non_string_status(monkeypatch):
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server.ssh_manager,
        "get_session_target",
        AsyncMock(return_value=("h", 22, "u")),
    )
    monkeypatch.setattr(
        server.ssh_manager, "handle_input", AsyncMock(return_value="forbidden")
    )
    result = await server.on_ssh_input(
        "sid", {"session_id": "sess", "tab_id": "tab", "data": "x"}
    )
    assert result["code"] == "session_owner_mismatch"
    monkeypatch.setattr(
        server.ssh_manager, "handle_input", AsyncMock(return_value=None)
    )
    assert await server.on_ssh_input(
        "sid", {"session_id": "sess", "tab_id": "tab", "data": "x"}
    ) == {"ok": True}


@pytest.mark.asyncio
async def test_ssh_interrupt_all_results(monkeypatch):
    invalid = await server.on_ssh_interrupt(
        "sid", {"session_id": "", "tab_id": ""}
    )
    assert invalid["code"] == "invalid_request"
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    assert (
        await server.on_ssh_interrupt(
            "sid", {"session_id": "sess", "tab_id": "tab"}
        )
    )["code"] == "auth_required"
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server.ssh_manager, "interrupt", AsyncMock(return_value="queued")
    )
    assert (
        await server.on_ssh_interrupt(
            "sid", {"session_id": "sess", "tab_id": "tab"}
        )
    )["ok"] is True
    monkeypatch.setattr(
        server.ssh_manager, "interrupt", AsyncMock(return_value="unknown")
    )
    assert (
        await server.on_ssh_interrupt(
            "sid", {"session_id": "sess", "tab_id": "tab"}
        )
    )["code"] == "session_not_found"


@pytest.mark.asyncio
async def test_resize_and_disconnect_auth_guards(monkeypatch):
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    await server.on_terminal_resize(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )
    await server.on_ssh_disconnect(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )

    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(
        server.ssh_manager, "disconnect_session", AsyncMock(return_value="forbidden")
    )
    await server.on_ssh_disconnect(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )
    assert sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"
    monkeypatch.setattr(
        server.ssh_manager, "disconnect_session", AsyncMock(return_value="unknown")
    )
    monkeypatch.setattr(server, "_cleanup_ssh_input_buffer", AsyncMock())
    await server.on_ssh_disconnect(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )
    server._cleanup_ssh_input_buffer.assert_awaited_once()

    monkeypatch.setattr(server.ssh_manager, "handle_resize", AsyncMock())
    await server.on_terminal_resize(
        "sid", {"session_id": "sess", "tab_id": "tab", "cols": 80, "rows": 24}
    )
    server.ssh_manager.handle_resize.assert_awaited_once()


@pytest.mark.asyncio
async def test_sftp_close_guard_and_clone_paths(monkeypatch):
    monkeypatch.setattr(server, "_sftp_request_guard", AsyncMock(return_value=None))
    assert await server.on_sftp_close("sid", {}) is None

    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    valid = {
        "session_id": "sess",
        "source_tab_id": "source",
        "new_tab_id": "target",
    }
    await server.on_ssh_clone("sid", {**valid, "new_tab_id": "bad/id"})
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"

    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    await server.on_ssh_clone("sid", valid)
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=None)
    )
    await server.on_ssh_clone("sid", valid)
    assert sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"

    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=("h", 22, "u"))
    )
    monkeypatch.setattr(server.ssh_manager, "session_count", MagicMock(return_value=999))
    await server.on_ssh_clone("sid", valid)
    assert sio.emit.await_args.args[1]["code"] == "capacity_reached"

    monkeypatch.setattr(server.ssh_manager, "session_count", MagicMock(return_value=0))
    monkeypatch.setattr(
        server.ssh_manager, "sid_session_count", MagicMock(return_value=999)
    )
    await server.on_ssh_clone("sid", valid)
    assert sio.emit.await_args.args[1]["code"] == "session_limit"

    monkeypatch.setattr(
        server.ssh_manager, "sid_session_count", MagicMock(return_value=0)
    )
    monkeypatch.setattr(server.ssh_manager, "clone", AsyncMock())
    await server.on_ssh_clone("sid", valid)
    server.ssh_manager.clone.assert_awaited_once()


@pytest.mark.asyncio
async def test_sftp_audit_swallows_failures(monkeypatch):
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server.sftp_manager,
        "session_target",
        AsyncMock(side_effect=RuntimeError("target failed")),
    )
    await server._record_sftp_events_audit(
        owner="alice",
        session_id="sess",
        tab_id="tab",
        operation="upload",
        entries=[("/x", 1, "")],
    )

    monkeypatch.setattr(
        server.sftp_manager, "session_target", AsyncMock(return_value=("h", 22, "u"))
    )
    monkeypatch.setattr(
        server.audit_store, "record_sftp_event", MagicMock(return_value=None)
    )
    await server._record_sftp_events_audit(
        owner="alice",
        session_id="sess",
        tab_id="tab",
        operation="upload",
        entries=[("/x", 1, "")],
    )
    server.audit_store.record_sftp_event.assert_called_once()

    await server._record_sftp_events_audit(
        owner=None,
        session_id="sess",
        tab_id="tab",
        operation="upload",
        entries=[("/x", 1, "")],
    )


@pytest.mark.asyncio
async def test_sftp_request_guard_and_owner_errors(monkeypatch):
    original_owner = server._require_sftp_session_owner
    assert (
        await server._sftp_request_guard("sid", {"session_id": "bad/id", "tab_id": "t"})
        is None
    )
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    assert (
        await server._sftp_request_guard(
            "sid", {"session_id": "sess", "tab_id": "tab"}
        )
        is None
    )
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server, "_require_sftp_session_owner", AsyncMock(return_value=False)
    )
    assert (
        await server._sftp_request_guard(
            "sid", {"session_id": "sess", "tab_id": "tab"}
        )
        is None
    )

    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(
        server.sftp_manager, "get_source_tab_id", MagicMock(return_value=None)
    )
    assert (
        await original_owner("sid", "sess", "tab", "list")
        is False
    )
    monkeypatch.setattr(
        server.sftp_manager, "get_source_tab_id", MagicMock(return_value="source")
    )
    monkeypatch.setattr(
        server, "_require_session_owner", AsyncMock(return_value=None)
    )
    assert (
        await original_owner("sid", "sess", "tab", "list")
        is False
    )
    monkeypatch.setattr(
        server, "_require_session_owner", AsyncMock(return_value="alice")
    )
    assert (
        await original_owner("sid", "sess", "tab", "list")
        is True
    )


@pytest.mark.asyncio
async def test_sftp_request_guard_accepts_a_verified_owner(monkeypatch):
    original_owner = server._require_sftp_session_owner
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server, "_require_sftp_session_owner", AsyncMock(return_value=True)
    )
    assert await server._sftp_request_guard(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    ) == ("sess", "tab")
    monkeypatch.setattr(
        server.sftp_manager, "get_source_tab_id", MagicMock(return_value=None)
    )
    assert (
        await original_owner("sid", "sess", "tab", "list")
        is False
    )
    monkeypatch.setattr(
        server.sftp_manager, "get_source_tab_id", MagicMock(return_value="source")
    )
    monkeypatch.setattr(
        server, "_require_session_owner", AsyncMock(return_value=None)
    )
    assert (
        await original_owner("sid", "sess", "tab", "list")
        is False
    )


@pytest.mark.asyncio
async def test_sftp_open_rejects_invalid_auth_owner_and_closed(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    await server.on_sftp_open("sid", {"session_id": "bad/id", "tab_id": "tab"})
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"

    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    assert await server.on_sftp_open(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    ) is None
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=None)
    )
    await server.on_sftp_open("sid", {"session_id": "sess", "tab_id": "tab"})
    assert sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"

    monkeypatch.setattr(
        server.ssh_manager, "get_session_target", AsyncMock(return_value=("h", 22, "u"))
    )
    monkeypatch.setattr(server.sftp_manager, "open_sftp", AsyncMock(return_value=False))
    await server.on_sftp_open("sid", {"session_id": "sess", "tab_id": "tab"})
    assert sio.emit.await_args.args[1]["code"] == "CONNECTION_CLOSED"


@pytest.mark.asyncio
async def test_sftp_open_restore_failures_and_success(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value=None))
    monkeypatch.setattr(server.sftp_manager, "open_sftp", AsyncMock(return_value=True))

    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(side_effect=SFTPError("FILE_NOT_FOUND", "missing")),
    )
    await server.on_sftp_open(
        "sid", {"session_id": "sess", "tab_id": "tab", "path": "."}
    )
    assert sio.emit.await_args.args[1]["code"] == "FILE_NOT_FOUND"

    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(
            side_effect=[
                SFTPError("FILE_NOT_FOUND", "remembered"),
                SFTPError("CONNECTION_CLOSED", "fallback"),
            ]
        ),
    )
    await server.on_sftp_open(
        "sid", {"session_id": "sess", "tab_id": "tab", "path": "/gone"}
    )
    assert sio.emit.await_args.args[1]["code"] == "CONNECTION_CLOSED"

    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(side_effect=[SFTPError("FILE_NOT_FOUND", "remembered"), {"ok": True}]),
    )
    monkeypatch.setattr(
        server.ssh_manager,
        "get_session_target",
        AsyncMock(side_effect=RuntimeError("target")),
    )
    monkeypatch.setattr(
        server.ssh_manager,
        "is_root_session",
        AsyncMock(side_effect=RuntimeError("root")),
    )
    await server.on_sftp_open(
        "sid", {"session_id": "sess", "tab_id": "tab", "path": "/gone"}
    )
    assert sio.emit.await_args.args[1]["username"] is None
    assert sio.emit.await_args.args[1]["is_root"] is False

    monkeypatch.setattr(
        server.ssh_manager,
        "get_session_target",
        AsyncMock(return_value=("h", 22, "root")),
    )
    monkeypatch.setattr(
        server.ssh_manager, "is_root_session", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(return_value={"ok": True, "path": "."}),
    )
    await server.on_sftp_open(
        "sid", {"session_id": "sess", "tab_id": "tab"}
    )
    assert sio.emit.await_args.args[1]["username"] == "root"
    assert sio.emit.await_args.args[1]["is_root"] is True


@pytest.mark.asyncio
async def test_sftp_handlers_guard_and_error_paths(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_sftp_request_guard", AsyncMock(return_value=None))
    assert await server.on_sftp_list("sid", {}) is None
    assert await server.on_sftp_download("sid", {}) is None
    assert await server.on_sftp_delete("sid", {}) is None

    for handler in (
        server.on_sftp_rename,
        server.on_sftp_mkdir,
        server.on_sftp_chmod,
        server.on_sftp_chown,
        server.on_sftp_accounts,
    ):
        assert await handler("sid", {}) is None

    monkeypatch.setattr(
        server, "_sftp_request_guard", AsyncMock(return_value=("sess", "tab"))
    )
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server, "_record_sftp_events_audit", AsyncMock()
    )
    monkeypatch.setattr(server.sftp_manager, "delete", AsyncMock(return_value={"ok": True, "path": "/x"}))
    await server.on_sftp_delete("sid", {"path": "/x"})
    assert sio.emit.await_args.args[1]["ok"] is True

    monkeypatch.setattr(server.sftp_manager, "delete", AsyncMock(side_effect=SFTPError("X", "bad")))
    await server.on_sftp_delete("sid", {"paths": ["a", "b"]})
    assert sio.emit.await_args.args[1]["ok"] is False

    monkeypatch.setattr(server.sftp_manager, "rename", AsyncMock(side_effect=SFTPError("X", "bad")))
    await server.on_sftp_rename("sid", {"old_path": "a", "new_path": "b"})
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(server.sftp_manager, "mkdir", AsyncMock(return_value={"ok": True, "path": "/x"}))
    await server.on_sftp_mkdir("sid", {"path": "/x"})
    assert sio.emit.await_args.args[1]["ok"] is True

    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(return_value={"ok": True, "entries": []}),
    )
    await server.on_sftp_list("sid", {"path": "."})
    assert sio.emit.await_args.args[1]["ok"] is True
    monkeypatch.setattr(
        server.sftp_manager,
        "list_directory",
        AsyncMock(side_effect=SFTPError("X", "bad")),
    )
    await server.on_sftp_list("sid", {"path": "."})
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(
        server.sftp_manager,
        "download_file",
        AsyncMock(return_value={"path": "/x", "size": 1}),
    )
    await server.on_sftp_download("sid", {"path": "/x"})
    assert sio.emit.await_args.args[0] == "sftp:download:result"
    monkeypatch.setattr(
        server.sftp_manager,
        "download_file",
        AsyncMock(side_effect=SFTPError("X", "bad")),
    )
    await server.on_sftp_download("sid", {"path": "/x"})
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(server, "_MAX_SFTP_BATCH_PATHS", 1)
    await server.on_sftp_delete("sid", {"paths": ["a", "b"]})
    assert sio.emit.await_args.args[1]["code"] == "too_many_paths"

    monkeypatch.setattr(
        server.sftp_manager,
        "rename",
        AsyncMock(return_value={"old_path": "/a", "new_path": "/b"}),
    )
    await server.on_sftp_rename("sid", {"old_path": "/a", "new_path": "/b"})
    assert sio.emit.await_args.args[0] == "sftp:rename:result"

    monkeypatch.setattr(
        server.sftp_manager, "mkdir", AsyncMock(side_effect=SFTPError("X", "bad"))
    )
    await server.on_sftp_mkdir("sid", {"path": "/x"})
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(
        server.sftp_manager,
        "chmod",
        AsyncMock(return_value={"ok": True, "path": "/x"}),
    )
    await server.on_sftp_chmod("sid", {"mode": 0o644, "path": "/x"})
    assert sio.emit.await_args.args[0] == "sftp:chmod:result"
    monkeypatch.setattr(
        server.sftp_manager,
        "chown",
        AsyncMock(return_value={"ok": True, "path": "/x"}),
    )
    await server.on_sftp_chown("sid", {"uid": 1, "gid": 2, "path": "/x"})
    assert sio.emit.await_args.args[0] == "sftp:chown:result"
    monkeypatch.setattr(
        server.sftp_manager,
        "accounts",
        AsyncMock(return_value={"ok": True, "users": [], "groups": []}),
    )
    await server.on_sftp_accounts("sid", {})
    assert sio.emit.await_args.args[0] == "sftp:accounts:result"


@pytest.mark.asyncio
async def test_sftp_mkdirs_validation_and_error(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server, "_require_sftp_session_owner", AsyncMock(return_value=True)
    )
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": [],
        },
    )
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_upload_directories",
        AsyncMock(side_effect=SFTPError("X", "bad")),
    )
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_upload_directories",
        AsyncMock(return_value={"ok": True, "created": []}),
    )
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    assert sio.emit.await_args.args[1]["ok"] is True

    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "bad/id",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=False))
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server, "_require_sftp_session_owner", AsyncMock(return_value=False)
    )
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    monkeypatch.setattr(
        server, "_require_sftp_session_owner", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        server.sftp_manager,
        "prepare_upload_directories",
        AsyncMock(return_value={"ok": True, "created": ["/a"]}),
    )
    monkeypatch.setattr(server, "_record_sftp_events_audit", AsyncMock())
    await server.on_sftp_mkdirs(
        "sid",
        {
            "session_id": "sess",
            "tab_id": "tab",
            "request_id": "req",
            "paths": ["/a"],
        },
    )
    server._record_sftp_events_audit.assert_awaited_once()


@pytest.mark.asyncio
async def test_sftp_chmod_chown_accounts_errors(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(
        server, "_sftp_request_guard", AsyncMock(return_value=("sess", "tab"))
    )
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="alice"))
    await server.on_sftp_chmod("sid", {"mode": True})
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"
    monkeypatch.setattr(server.sftp_manager, "chmod", AsyncMock(side_effect=SFTPError("X", "bad")))
    await server.on_sftp_chmod("sid", {"mode": 0o644})
    assert sio.emit.await_args.args[1]["code"] == "X"

    await server.on_sftp_chown("sid", {"uid": True, "gid": 1})
    assert sio.emit.await_args.args[1]["code"] == "invalid_request"
    monkeypatch.setattr(server.sftp_manager, "chown", AsyncMock(side_effect=SFTPError("X", "bad")))
    await server.on_sftp_chown("sid", {"uid": 1, "gid": 1})
    assert sio.emit.await_args.args[1]["code"] == "X"

    monkeypatch.setattr(server.sftp_manager, "accounts", AsyncMock(side_effect=SFTPError("X", "bad")))
    await server.on_sftp_accounts("sid", {})
    assert sio.emit.await_args.args[1]["code"] == "X"


@pytest.mark.asyncio
async def test_sftp_close_result(monkeypatch):
    sio = MagicMock()
    sio.emit = AsyncMock()
    monkeypatch.setattr(server, "sio", sio)
    monkeypatch.setattr(
        server, "_sftp_request_guard", AsyncMock(return_value=("sess", "tab"))
    )
    monkeypatch.setattr(server.sftp_manager, "close_sftp", AsyncMock())
    await server.on_sftp_close("sid", {})
    assert sio.emit.await_args.args[1]["ok"] is True


@pytest.mark.asyncio
async def test_upload_helpers_validate_ids_and_target_fields(monkeypatch):
    with pytest.raises(HTTPException):
        server._upload_ids(request_for(query={}))
    assert server._upload_ids(
        request_for(query={"session_id": "sess", "tab_id": "tab"})
    ) == ("sess", "tab")
    assert server._sftp_status_for(SFTPError("FILE_NOT_FOUND", "x")) == 404
    assert server._sftp_status_for(SFTPError("PERMISSION_DENIED", "x")) == 403
    assert server._sftp_status_for(SFTPError("X", "x")) == 400

    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value=None))
    with pytest.raises(HTTPException) as exc:
        await server._upload_authorize(
            request_for(query={"session_id": "sess", "tab_id": "tab"}), "write"
        )
    assert exc.value.status_code == 401
    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="alice"))
    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=False))
    with pytest.raises(HTTPException) as exc:
        await server._upload_authorize(
            request_for(query={"session_id": "sess", "tab_id": "tab"}), "write"
        )
    assert exc.value.status_code == 403
    monkeypatch.setattr(server, "_sftp_session_owned", AsyncMock(return_value=True))
    context = await server._upload_authorize(
        request_for(query={"session_id": "sess", "tab_id": "tab"}), "write"
    )
    assert context.user == "alice"
    assert context.extra == {"session_id": "sess", "tab_id": "tab"}


@pytest.mark.asyncio
async def test_upload_open_target_rejects_bad_fields(monkeypatch):
    request = request_for(query={"session_id": "sess", "tab_id": "tab"})
    for body, detail in (
        ({"filename": 1}, "invalid_filename"),
        ({"filename": ""}, "invalid_filename"),
        ({"filename": "x", "size": "bad"}, "invalid_size"),
        ({"filename": "x", "dir": 1}, "invalid_directory"),
    ):
        with pytest.raises(HTTPException) as exc:
            await server._upload_open_target(request, body)
        assert exc.value.detail == detail

    monkeypatch.setattr(
        server.sftp_manager,
        "resolve_upload_path",
        MagicMock(side_effect=SFTPError("PERMISSION_DENIED", "denied")),
    )
    with pytest.raises(HTTPException) as exc:
        await server._upload_open_target(request, {"filename": "x"})
    assert exc.value.status_code == 403

    monkeypatch.setattr(server, "_http_owner", AsyncMock(return_value="alice"))
    monkeypatch.setattr(
        server.sftp_manager,
        "resolve_upload_path",
        MagicMock(return_value="/home/alice/x"),
    )
    target = await server._upload_open_target(
        request,
        {
            "filename": "x",
            "size": 4,
            "dir": "/home/%61lice",
            "session_id": "upload",
        },
    )
    assert target.directory == "/home/alice"
    assert target.filename == "x"
    assert target.extra["resolved"] == "/home/alice/x"


@pytest.mark.asyncio
async def test_upload_complete_records_the_audited_destination(monkeypatch):
    record = AsyncMock()
    monkeypatch.setattr(server, "_record_sftp_events_audit", record)
    session = SimpleNamespace(
        user="alice",
        target=SimpleNamespace(
            extra={"session_id": "sess", "tab_id": "tab", "resolved": "/home/a/x"}
        ),
        ranges=SimpleNamespace(total=MagicMock(return_value=4)),
    )
    await server._upload_complete(session, "/home/a/x")
    record.assert_awaited_once_with(
        owner="alice",
        session_id="sess",
        tab_id="tab",
        operation="upload",
        entries=[("/home/a/x", 4, "")],
    )


def test_module_level_dev_log_and_ldap_configuration(monkeypatch, tmp_path):
    import runpy

    import ldapgate.config
    import ldapgate.middleware
    import ldapgate.sessions

    log_file = tmp_path / "torrus.log"
    monkeypatch.setenv("TORRUS_LOG_FILE", str(log_file))
    monkeypatch.setenv("TORRUS_DEV", "1")
    monkeypatch.setenv("TORRUS_LDAP_CONFIG", str(tmp_path / "ldap.yaml"))
    monkeypatch.setenv("TORRUS_UPLOAD_CHUNK_BYTES", "999999999")
    proxy = SimpleNamespace(
        static_paths=[],
        session_cookie_name="ldapgate_session",
        max_body_size=100,
        secret_key=SimpleNamespace(get_secret_value=lambda: "secret"),
        session_ttl=60,
        revocation_path=str(tmp_path / "revoked"),
        max_sessions_per_user=3,
        bind_client=None,
        idle_timeout=5,
        secure_cookies=False,
        trusted_proxies=[],
    )
    config = SimpleNamespace(proxy=proxy, ldap=SimpleNamespace(allowed_users=[]))
    monkeypatch.setattr(ldapgate.config, "load_config", lambda _path: config)
    monkeypatch.setattr(ldapgate.middleware, "add_ldap_auth", lambda *_a, **_k: None)
    monkeypatch.setattr(ldapgate.sessions, "SessionManager", MagicMock())

    namespace = runpy.run_path(
        str(Path(server.__file__).resolve()), run_name="torrus_server_reload"
    )
    assert namespace["_ldap_enabled"] is True
    assert namespace["_UPLOAD_CHUNK_BYTES"] == 100
    assert log_file.exists()

    monkeypatch.setattr(
        ldapgate.middleware, "add_ldap_auth", lambda *_a, **_k: MagicMock()
    )
    proxy.max_body_size = 10**9
    monkeypatch.setenv("TORRUS_UPLOAD_CHUNK_BYTES", "1000")
    namespace = runpy.run_path(
        str(Path(server.__file__).resolve()), run_name="torrus_server_reload_large"
    )
    assert namespace["_ldap_session_manager"] is not None
    assert namespace["_UPLOAD_CHUNK_BYTES"] == 1000


def test_missing_ldapgate_fails_startup(monkeypatch, tmp_path):
    import runpy

    monkeypatch.setenv("TORRUS_LDAP_CONFIG", str(tmp_path / "ldap.yaml"))
    monkeypatch.setitem(sys.modules, "ldapgate.config", None)
    with pytest.raises(RuntimeError, match="ldapgate is not installed"):
        runpy.run_path(
            str(Path(server.__file__).resolve()), run_name="torrus_server_missing_ldap"
        )


def test_static_fallbacks_without_a_bundle_or_index(monkeypatch, tmp_path):
    empty = tmp_path / "empty-static"
    empty.mkdir()
    monkeypatch.setattr(server, "_static", empty)
    assert asyncio.run(server._root_static_file("missing", "text/plain")).status_code == 404
    assert asyncio.run(server.spa_fallback("", request_for())).status_code == 503

    monkeypatch.setattr(server, "_static", None)
    assert asyncio.run(server._root_static_file("missing", "text/plain")).status_code == 404


def test_ldapgate_static_paths_preserve_custom_cookie_and_existing_paths():
    paths = ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/manifest.webmanifest"]
    proxy = SimpleNamespace(session_cookie_name="custom", static_paths=list(paths))

    server._ensure_ldapgate_static_paths(SimpleNamespace(proxy=proxy))

    assert proxy.session_cookie_name == "custom"
    assert proxy.static_paths == paths


def test_admin_hosts_without_configuration_or_host_header(monkeypatch):
    monkeypatch.setattr(server, "_ldap_config", None)
    monkeypatch.setattr(server, "_DEV_MODE", False)

    assert server._admin_hosts(request_for(headers={})) == set()


@pytest.mark.asyncio
async def test_admin_guard_allows_a_valid_mutation(monkeypatch):
    monkeypatch.setattr(server, "_admin_actor", AsyncMock(return_value=("admin", None)))
    monkeypatch.setattr(server, "_ldap_enabled", True)
    monkeypatch.setattr(server, "_admin_origin_allowed", lambda _request: True)
    monkeypatch.setattr(server, "_admin_csrf_valid", AsyncMock(return_value=True))

    actor, error = await server._admin_guard(request_for(), mutate=True)
    assert actor == "admin"
    assert error is None


@pytest.mark.asyncio
async def test_ssh_disconnect_closed_skips_input_cleanup(monkeypatch):
    monkeypatch.setattr(server, "_require_auth", AsyncMock(return_value=True))
    monkeypatch.setattr(server, "_owner_for_sid", AsyncMock(return_value="admin"))
    monkeypatch.setattr(
        server.ssh_manager, "disconnect_session", AsyncMock(return_value="closed")
    )
    cleanup = AsyncMock()
    monkeypatch.setattr(server, "_cleanup_ssh_input_buffer", cleanup)

    await server.on_ssh_disconnect("sid", {"session_id": "sess", "tab_id": "tab"})

    cleanup.assert_not_awaited()


@pytest.mark.asyncio
async def test_emit_sftp_error_without_operation(monkeypatch):
    emit = AsyncMock()
    monkeypatch.setattr(server.sio, "emit", emit)

    await server._emit_sftp_error("sid", "tab", SFTPError("X", "bad"), None)

    assert "operation" not in emit.await_args.args[1]


def test_server_import_handles_missing_static_bundle(monkeypatch, tmp_path):
    import importlib.resources
    import runpy

    monkeypatch.delenv("TORRUS_LDAP_CONFIG", raising=False)
    monkeypatch.setattr(importlib.resources, "files", lambda _package: tmp_path)

    namespace = runpy.run_path(
        str(Path(server.__file__).resolve()), run_name="torrus_server_no_static"
    )
    assert namespace["_static"] is None

    (tmp_path / "static").mkdir()
    namespace = runpy.run_path(
        str(Path(server.__file__).resolve()), run_name="torrus_server_no_assets"
    )
    assert namespace["_static"] == tmp_path / "static"


@pytest.mark.asyncio
async def test_security_headers_are_not_added_to_auth_paths():
    response = Response()
    call_next = AsyncMock(return_value=response)

    result = await server.add_app_security_headers(
        request_for(path="/_auth/login"), call_next
    )

    assert result is response
    assert "content-security-policy" not in result.headers


def test_admin_hosts_prefers_configured_trusted_hosts(monkeypatch):
    monkeypatch.setattr(
        server,
        "_ldap_config",
        SimpleNamespace(proxy=SimpleNamespace(trusted_hosts=["Trusted.Example"])),
    )
    monkeypatch.setattr(server, "_DEV_MODE", False)

    assert server._admin_hosts(request_for(headers={"host": "ignored"})) == {
        "trusted.example"
    }
