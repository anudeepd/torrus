import asyncio
import types
from pathlib import Path

from starlette.responses import FileResponse

from torrus.server import (
    APP_CSP,
    _ensure_ldapgate_static_paths,
    api_config,
    fastapi_app,
    favicon,
)


def test_app_csp_allows_self_fonts_and_websockets():
    assert "font-src 'self'" in APP_CSP
    assert "font-src 'self' data:" in APP_CSP
    assert "connect-src 'self' ws: wss:" in APP_CSP


def test_ensure_ldapgate_static_paths_preserves_existing_paths():
    proxy = types.SimpleNamespace(static_paths=["/custom"])
    config = types.SimpleNamespace(proxy=proxy)

    _ensure_ldapgate_static_paths(config)

    assert proxy.session_cookie_name == "torrus_session"
    assert proxy.static_paths == ["/custom", "/favicon.svg", "/favicon.ico"]


def test_api_config_exposes_ldap_idle_timeout(monkeypatch):
    import torrus.server as server_module

    monkeypatch.setenv("TORRUS_LDAP_CONFIG", "/etc/torrus/ldap.yaml")
    monkeypatch.setattr(
        server_module,
        "_ldap_config",
        types.SimpleNamespace(proxy=types.SimpleNamespace(idle_timeout=900)),
    )

    assert asyncio.run(api_config()) == {
        "ldap_enabled": True,
        "ldap_idle_timeout": 900,
    }


def test_login_template_uses_nonce_for_inline_assets():
    template = (
        Path(__file__).resolve().parents[1] / "src" / "torrus" / "templates" / "login.html"
    ).read_text()
    assert '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' in template
    assert '<style nonce="{{ csrf_nonce }}">' in template
    assert '<script nonce="{{ csrf_nonce }}">' in template
    assert '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">' in template
    assert "torrus-card-in" in template
    assert "torrus-error-up" in template
    assert "torrus:login:username" in template
    assert "Signing in" in template
    assert "Secured by" in template
    assert "security-lock" in template
    assert "max-width: 380px;" in template
    assert "min-height: 40px;" in template
    assert "line-height: 1.25rem;" in template
    assert ".submit-label { min-width: 4.75rem; }" in template
    assert "appearance: none;" in template
    assert "-webkit-appearance: none;" in template
    assert 'id="password-toggle"' not in template
    assert 'style="' not in template
    assert "meta http-equiv=\"Content-Security-Policy\"" not in template


def test_favicon_svg_is_served_before_spa_fallback():
    paths = [getattr(route, "path", None) for route in fastapi_app.routes]
    response = asyncio.run(favicon())

    assert paths.index("/favicon.svg") < paths.index("/{full_path:path}")
    assert isinstance(response, FileResponse)
    assert response.status_code == 200
    assert response.media_type == "image/svg+xml"
    assert response.path.endswith("favicon.svg")
