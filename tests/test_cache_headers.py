"""Cache policy and CSP nonce wiring for frontend deployment updates."""

import re

import pytest
from starlette.requests import Request
from starlette.responses import Response


@pytest.mark.asyncio
async def test_spa_shell_revalidates_and_hashed_assets_are_immutable():
    from torrus.server import _static, add_app_security_headers, spa_fallback

    assert _static is not None
    shell = await spa_fallback(
        "",
        Request({"type": "http", "path": "/", "headers": []}),
    )
    request = Request({"type": "http", "path": "/assets/index-hash.js", "headers": []})

    async def asset_response(_request):
        return Response()

    bundled_asset = await add_app_security_headers(request, asset_response)

    assert shell.headers["cache-control"] == "no-cache, must-revalidate"
    assert (
        bundled_asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    )


@pytest.mark.asyncio
async def test_spa_shell_carries_the_same_style_nonce_as_the_csp_header():
    from torrus.server import add_app_security_headers, spa_fallback

    request = Request({"type": "http", "path": "/", "headers": [], "state": {}})

    async def shell(_request):
        return await spa_fallback("", request)

    response = await add_app_security_headers(request, shell)
    csp = response.headers["content-security-policy"]
    match = re.search(r"style-src 'self' 'nonce-([^']+)'", csp)
    nonce = match.group(1) if match else None

    assert nonce
    body = response.body.decode()
    assert f'<meta name="csp-style-nonce" content="{nonce}"' in body
    assert "unsafe-inline" not in csp


@pytest.mark.asyncio
async def test_the_document_policy_keeps_a_same_origin_referrer():
    """ldapgate's logout CSRF check rejects a POST with no Referer at all."""
    from torrus.server import add_app_security_headers

    request = Request({"type": "http", "path": "/", "headers": []})

    async def shell(_request):
        return Response()

    response = await add_app_security_headers(request, shell)

    assert response.headers["referrer-policy"] == "same-origin"
