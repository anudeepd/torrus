import asyncio
import types
from pathlib import Path

import pytest
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
    assert "connect-src 'self';" in APP_CSP
    assert "ws:" not in APP_CSP.split("connect-src")[1].split(";")[0]
    assert "frame-ancestors 'none'" in APP_CSP
    assert "form-action 'self'" in APP_CSP
    assert "object-src 'none'" in APP_CSP


def test_ensure_ldapgate_static_paths_preserves_existing_paths():
    proxy = types.SimpleNamespace(static_paths=["/custom"])
    config = types.SimpleNamespace(proxy=proxy)

    _ensure_ldapgate_static_paths(config)

    assert proxy.session_cookie_name == "torrus_session"
    assert proxy.static_paths == [
        "/custom",
        "/favicon.svg",
        "/favicon.ico",
        "/apple-touch-icon.png",
        "/manifest.webmanifest",
    ]


def test_api_config_exposes_ldap_idle_timeout(monkeypatch):
    import torrus.server as server_module

    monkeypatch.setenv("TORRUS_LDAP_CONFIG", "/etc/torrus/ldap.yaml")
    monkeypatch.setattr(
        server_module,
        "_ldap_config",
        types.SimpleNamespace(proxy=types.SimpleNamespace(idle_timeout=900)),
    )

    assert asyncio.run(api_config(types.SimpleNamespace(scope={}, client=None))) == {
        "ldap_enabled": True,
        "ldap_idle_timeout": 900,
        "is_admin": False,
    }


def test_login_template_keeps_its_csp_and_password_contract():
    """The login template's security and behaviour contract, not its styling.

    Restyling the card must not fail this test; dropping a nonce, the CSRF field,
    an inline style attribute, or the guard against the browser's own password
    reveal must.
    """
    template = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "torrus"
        / "templates"
        / "login.html"
    ).read_text()

    # CSP: every inline <style>/<script> carries the per-response nonce, and the
    # policy stays a response header rather than a weaker meta tag.
    assert "<style nonce=\"{{ csrf_nonce }}\">" in template
    assert "<script nonce=\"{{ csrf_nonce }}\">" in template
    assert 'style="' not in template
    assert 'meta http-equiv="Content-Security-Policy"' not in template

    # CSRF token travels with the form.
    assert '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">' in template

    # The custom toggle must be the only reveal control: the browser's own
    # affordances would double up with it.
    assert 'input[type="password"]::-ms-reveal' in template
    assert "::-moz-reveal" not in template
    assert "credentials-auto-fill-button" not in template
    assert "password.type = showing ? 'text' : 'password';" in template

    assert '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' in template


def test_favicon_svg_is_served_before_spa_fallback():
    paths = [getattr(route, "path", None) for route in fastapi_app.routes]
    response = asyncio.run(favicon())

    assert paths.index("/favicon.svg") < paths.index("/{full_path:path}")
    assert isinstance(response, FileResponse)
    assert response.status_code == 200
    assert response.media_type == "image/svg+xml"
    assert response.path.endswith("favicon.svg")

def test_ldapgate_parses_the_shipped_config_and_we_extend_it():
    """End-to-end coverage of the one thing torrus does to a real ldapgate config.

    Needs the `ldap` extra: it is skipped locally when ldapgate is not installed
    and runs in the CI job that installs it.
    """
    pytest.importorskip("ldapgate")

    from ldapgate.config import load_config

    from torrus.server import _ensure_ldapgate_static_paths

    config = load_config(str(Path(__file__).resolve().parents[1] / "ldapgate.yaml"))
    _ensure_ldapgate_static_paths(config)

    assert config.ldap.url == "ldaps://ldap.example.com:636"
    assert config.proxy.app_name == "Torrus"
    # Torrus renames the cookie and whitelists its public assets.
    assert config.proxy.session_cookie_name == "torrus_session"
    for path in ("/favicon.svg", "/apple-touch-icon.png", "/manifest.webmanifest"):
        assert path in config.proxy.static_paths
