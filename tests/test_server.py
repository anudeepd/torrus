"""Tests for torrus.server Socket.IO event handlers."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestValidIdChecks:
    """Ensure malformed session/tab IDs are rejected at the handler level."""

    @pytest.mark.asyncio
    async def test_ssh_input_rejects_invalid_ids(self):
        from torrus.server import on_ssh_input

        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()

        with patch("torrus.server.sio", sio_mock):
            result = await on_ssh_input("sid-1", {"session_id": "bad id!", "tab_id": "tab1", "data": "x"})
            assert result == {"ok": False, "error": "Invalid session or tab ID."}

            result = await on_ssh_input("sid-1", {"session_id": "sess1", "tab_id": "", "data": "x"})
            assert result == {"ok": False, "error": "Invalid session or tab ID."}

    @pytest.mark.asyncio
    async def test_terminal_resize_rejects_invalid_ids(self):
        from torrus.server import on_terminal_resize, ssh_manager

        sio_mock = MagicMock()
        with patch("torrus.server.sio", sio_mock):
            with patch.object(ssh_manager, "handle_resize", AsyncMock()) as mock_resize:
                await on_terminal_resize("sid-1", {"session_id": "../etc", "tab_id": "tab1", "cols": 80, "rows": 24})
                mock_resize.assert_not_called()

    @pytest.mark.asyncio
    async def test_ssh_disconnect_rejects_invalid_ids(self):
        from torrus.server import on_ssh_disconnect, ssh_manager

        sio_mock = MagicMock()
        with patch("torrus.server.sio", sio_mock):
            with patch.object(ssh_manager, "disconnect_session", AsyncMock()) as mock_disconnect:
                await on_ssh_disconnect("sid-1", {"session_id": "sess1", "tab_id": "tab id!"})
                mock_disconnect.assert_not_called()

    @pytest.mark.asyncio
    async def test_session_register_rejects_invalid_ids(self):
        from torrus.server import on_session_register, ssh_manager

        sio_mock = MagicMock()
        with patch("torrus.server.sio", sio_mock):
            with patch.object(ssh_manager, "restore_session", AsyncMock()) as mock_restore:
                await on_session_register("sid-1", {"session_id": "", "tab_id": "tab1"})
                mock_restore.assert_not_called()


class TestLdapAuthGating:
    """When LDAP is enabled, only authenticated sids may perform SSH actions."""

    @pytest.fixture(autouse=True)
    def enable_ldap(self, reset_server_state):
        import torrus.server as server_module

        server_module._ldap_enabled = True
        yield
        server_module._ldap_enabled = False

    @pytest.mark.asyncio
    async def test_ssh_connect_blocked_without_cookie(self):
        from torrus.server import on_ssh_connect

        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()
        with patch("torrus.server.sio", sio_mock):
            await on_ssh_connect(
                "unauth-sid",
                {
                    "host": "example.com",
                    "port": 22,
                    "username": "user",
                    "password": "pass",
                    "session_id": "sess1",
                    "tab_id": "tab1",
                },
            )
            sio_mock.emit.assert_awaited_once()
            args = sio_mock.emit.call_args[0][0]
            assert args == "ssh:error"
            assert sio_mock.emit.call_args[0][1]["code"] == "auth_required"

    @pytest.mark.asyncio
    async def test_ssh_connect_allowed_with_authenticated_sid(self):
        from torrus.server import on_ssh_connect, ssh_manager

        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()

        import torrus.server as server_module

        server_module._authenticated_sids.add("auth-sid")
        server_module.ssh_manager = MagicMock()
        server_module.ssh_manager.sid_session_count.return_value = 0
        server_module.ssh_manager.connect = AsyncMock()

        with patch("torrus.server.sio", sio_mock):
            await on_ssh_connect(
                "auth-sid",
                {
                    "host": "example.com",
                    "port": 22,
                    "username": "user",
                    "password": "pass",
                    "session_id": "sess1",
                    "tab_id": "tab1",
                },
            )
            # Should NOT emit auth_required error
            for call in sio_mock.emit.call_args_list:
                assert call[0][1].get("code") != "auth_required"
            server_module.ssh_manager.connect.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_on_connect_records_auth_sid_when_cookie_present(self):
        from torrus.server import on_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._authenticated_sids.clear()
        server_module._ldap_config = None
        server_module._ldap_session_manager = MagicMock()
        server_module._ldap_session_manager.verify_session.return_value = "alice"

        await on_connect(
            "sid-cookie",
            {"REMOTE_ADDR": "1.2.3.4", "HTTP_COOKIE": "ldapgate_session=abc"},
        )
        assert "sid-cookie" in server_module._authenticated_sids

    @pytest.mark.asyncio
    async def test_on_connect_uses_asgi_scope_client_ip(self):
        from torrus.server import on_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._authenticated_sids.clear()
        server_module._ldap_config = None
        server_module._ldap_session_manager = MagicMock()
        server_module._ldap_session_manager.verify_session.return_value = "alice"

        await on_connect(
            "sid-asgi",
            {
                "REMOTE_ADDR": "127.0.0.1",
                "HTTP_COOKIE": "ldapgate_session=abc",
                "HTTP_USER_AGENT": "test-agent",
                "asgi.scope": {"client": ("203.0.113.7", 54221), "headers": []},
            },
        )

        server_module._ldap_session_manager.verify_session.assert_called_once_with(
            "abc",
            client_ip="203.0.113.7",
            user_agent="test-agent",
        )
        assert "sid-asgi" in server_module._authenticated_sids

    def test_verify_ldap_socket_session_accepts_alternate_ip_binding(self):
        from torrus.server import _verify_ldap_socket_session

        import types
        import torrus.server as server_module

        manager = MagicMock()
        manager.verify_session.side_effect = (
            lambda cookie, client_ip="", user_agent="": (
                "alice"
                if cookie == "signed-cookie"
                and client_ip == "127.0.0.1"
                and user_agent == "test-agent"
                else None
            )
        )

        server_module._ldap_config = types.SimpleNamespace(
            proxy=types.SimpleNamespace(
                session_cookie_name="torrus_session",
                secure_cookies=False,
                trusted_proxies=[],
            )
        )
        server_module._ldap_session_manager = manager

        assert _verify_ldap_socket_session(
            {
                "REMOTE_ADDR": "127.0.0.1",
                "HTTP_COOKIE": "torrus_session=signed-cookie",
                "HTTP_USER_AGENT": "test-agent",
                "asgi.scope": {"client": ("203.0.113.7", 54221), "headers": []},
            }
        )

    @pytest.mark.asyncio
    async def test_on_connect_uses_configured_cookie_name(self):
        from torrus.server import on_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._authenticated_sids.clear()
        server_module._ldap_config = MagicMock()
        server_module._ldap_config.proxy.session_cookie_name = "torrus_session"
        server_module._ldap_config.proxy.secure_cookies = False
        server_module._ldap_config.proxy.trusted_proxies = []
        server_module._ldap_session_manager = MagicMock()
        server_module._ldap_session_manager.verify_session.return_value = "alice"

        await on_connect(
            "sid-cookie",
            {
                "REMOTE_ADDR": "1.2.3.4",
                "HTTP_COOKIE": "ldapgate_session=old; torrus_session=abc",
                "HTTP_USER_AGENT": "test-agent",
            },
        )

        server_module._ldap_session_manager.verify_session.assert_called_once_with(
            "abc",
            client_ip="1.2.3.4",
            user_agent="test-agent",
        )
        assert "sid-cookie" in server_module._authenticated_sids

    @pytest.mark.asyncio
    async def test_on_connect_skips_auth_without_cookie(self):
        from torrus.server import on_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._authenticated_sids.clear()
        server_module._ldap_config = None
        server_module._ldap_session_manager = MagicMock()
        server_module._ldap_session_manager.verify_session.return_value = None

        await on_connect("sid-nocookie", {"REMOTE_ADDR": "1.2.3.4"})
        assert "sid-nocookie" not in server_module._authenticated_sids

    @pytest.mark.asyncio
    async def test_ssh_connect_lazily_authenticates_from_socket_environ(self):
        from torrus.server import on_ssh_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._authenticated_sids.clear()
        server_module._ldap_config = None
        server_module._ldap_session_manager = MagicMock()
        server_module._ldap_session_manager.verify_session.return_value = "alice"
        original_manager = server_module.ssh_manager
        manager_mock = MagicMock()
        manager_mock.sid_session_count.return_value = 0
        manager_mock.connect = AsyncMock()
        server_module.ssh_manager = manager_mock

        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()
        sio_mock.get_environ.return_value = {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_COOKIE": "ldapgate_session=abc",
            "HTTP_USER_AGENT": "test-agent",
            "asgi.scope": {"client": ("203.0.113.7", 54221), "headers": []},
        }

        try:
            with patch("torrus.server.sio", sio_mock):
                await on_ssh_connect(
                    "sid-lazy",
                    {
                        "host": "example.com",
                        "port": 22,
                        "username": "user",
                        "password": "pass",
                        "session_id": "sess1",
                        "tab_id": "tab1",
                    },
                )
        finally:
            server_module.ssh_manager = original_manager

        for call in sio_mock.emit.call_args_list:
            assert call[0][1].get("code") != "auth_required"
        manager_mock.connect.assert_awaited_once()
        assert "sid-lazy" in server_module._authenticated_sids

    @pytest.mark.asyncio
    async def test_ssh_input_records_raw_input_for_authenticated_ldap_user(self):
        from torrus.server import on_ssh_input

        import torrus.server as server_module

        server_module._authenticated_sids.add("auth-sid")
        server_module._authenticated_users["auth-sid"] = "alice"
        with patch.object(server_module.ssh_manager, "handle_input", AsyncMock()), \
             patch.object(server_module.ssh_manager, "get_session_target", AsyncMock(return_value=("db.example", 22, "root"))), \
             patch("torrus.server.audit_store.record_terminal_input", AsyncMock()) as record:
            result = await on_ssh_input(
                "auth-sid", {"session_id": "sess1", "tab_id": "tab1", "data": "echo hi\r"}
            )

        assert result == {"ok": True}
        record.assert_awaited_once_with(
            ldap_username="alice", session_id="sess1", tab_id="tab1", input_data="echo hi\r",
            ssh_host="db.example", ssh_port=22, ssh_username="root",
        )


class TestSessionRateLimit:
    """Per-sid session count limits must be enforced."""

    @pytest.mark.asyncio
    async def test_ssh_connect_blocked_when_limit_reached(self):
        from torrus.server import on_ssh_connect

        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()

        import torrus.server as server_module

        server_module.ssh_manager = MagicMock()
        server_module.ssh_manager.sid_session_count.return_value = server_module._MAX_SESSIONS_PER_SID

        with patch("torrus.server.sio", sio_mock):
            await on_ssh_connect(
                "sid-full",
                {
                    "host": "example.com",
                    "port": 22,
                    "username": "user",
                    "password": "pass",
                    "session_id": "sess1",
                    "tab_id": "tab1",
                },
            )
            sio_mock.emit.assert_awaited_once()
            assert sio_mock.emit.call_args[0][1]["code"] == "session_limit"


class TestPrivateHostPolicy:
    """Private/local SSH targets are allowed by default, with an operator opt-out."""

    @pytest.mark.asyncio
    async def test_private_host_allowed_without_ldap_by_default(self):
        from torrus.server import on_ssh_connect

        import torrus.server as server_module

        server_module._ldap_enabled = False
        server_module._ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = True
        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()
        original_manager = server_module.ssh_manager
        manager_mock = MagicMock()
        manager_mock.sid_session_count.return_value = 0
        manager_mock.connect = AsyncMock()
        server_module.ssh_manager = manager_mock

        try:
            with patch("torrus.server.sio", sio_mock):
                await on_ssh_connect(
                    "sid-public",
                    {
                        "host": "127.0.0.1",
                        "port": 22,
                        "username": "user",
                        "password": "pass",
                        "session_id": "sess1",
                        "tab_id": "tab1",
                    },
                )
        finally:
            server_module.ssh_manager = original_manager

        for call in sio_mock.emit.call_args_list:
            assert call[0][1].get("code") != "private_host_blocked"
        manager_mock.connect.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_private_host_blocked_without_ldap_when_explicitly_disabled(self):
        from torrus.server import on_ssh_connect

        import torrus.server as server_module

        server_module._ldap_enabled = False
        server_module._ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = False
        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()
        original_manager = server_module.ssh_manager
        manager_mock = MagicMock()
        manager_mock.sid_session_count.return_value = 0
        manager_mock.connect = AsyncMock()
        server_module.ssh_manager = manager_mock

        try:
            with patch("torrus.server.sio", sio_mock):
                await on_ssh_connect(
                    "sid-public",
                    {
                        "host": "127.0.0.1",
                        "port": 22,
                        "username": "user",
                        "password": "pass",
                        "session_id": "sess1",
                        "tab_id": "tab1",
                    },
                )
        finally:
            server_module.ssh_manager = original_manager
            server_module._ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = True

        sio_mock.emit.assert_awaited_once()
        assert sio_mock.emit.call_args[0][1]["code"] == "private_host_blocked"
        manager_mock.connect.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_private_host_allowed_with_ldap_authenticated_sid(self):
        from torrus.server import on_ssh_connect

        import torrus.server as server_module

        server_module._ldap_enabled = True
        server_module._ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP = True
        server_module._authenticated_sids.add("auth-sid")
        sio_mock = MagicMock()
        sio_mock.emit = AsyncMock()
        original_manager = server_module.ssh_manager
        manager_mock = MagicMock()
        manager_mock.sid_session_count.return_value = 0
        manager_mock.connect = AsyncMock()
        server_module.ssh_manager = manager_mock

        try:
            with patch("torrus.server.sio", sio_mock):
                await on_ssh_connect(
                    "auth-sid",
                    {
                        "host": "127.0.0.1",
                        "port": 22,
                        "username": "user",
                        "password": "pass",
                        "session_id": "sess1",
                        "tab_id": "tab1",
                    },
                )
        finally:
            server_module.ssh_manager = original_manager

        for call in sio_mock.emit.call_args_list:
            assert call[0][1].get("code") != "private_host_blocked"
        manager_mock.connect.assert_awaited_once()


class TestIpLogging:
    """on_connect should log the real client IP, including reverse-proxy headers."""

    @pytest.mark.asyncio
    async def test_uses_x_forwarded_for_when_present(self):
        from torrus import server as server_module

        with patch.object(server_module.logger, "info") as mock_info:
            await server_module.on_connect(
                "sid-1",
                {
                    "REMOTE_ADDR": "10.0.0.1",
                    "HTTP_X_FORWARDED_FOR": "203.0.113.42, 10.0.0.1",
                },
            )
            mock_info.assert_called_once()
            # logger.info is called as logger.info(fmt, sid, remote)
            remote_arg = mock_info.call_args[0][2]
            assert remote_arg == "203.0.113.42"

    @pytest.mark.asyncio
    async def test_falls_back_to_remote_addr(self):
        from torrus import server as server_module

        with patch.object(server_module.logger, "info") as mock_info:
            await server_module.on_connect("sid-1", {"REMOTE_ADDR": "192.168.1.5"})
            mock_info.assert_called_once()
            remote_arg = mock_info.call_args[0][2]
            assert remote_arg == "192.168.1.5"


class TestSocketDisconnect:
    """Socket disconnect cleanup must await async SSH manager cleanup."""

    @pytest.mark.asyncio
    async def test_on_disconnect_awaits_unmap_sid(self):
        from torrus import server as server_module

        original_manager = server_module.ssh_manager
        manager = MagicMock()
        manager.unmap_sid = AsyncMock()
        server_module.ssh_manager = manager
        try:
            await server_module.on_disconnect("sid-1")
        finally:
            server_module.ssh_manager = original_manager

        manager.unmap_sid.assert_awaited_once_with("sid-1")
