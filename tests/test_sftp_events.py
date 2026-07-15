"""Tests for SFTP Socket.IO event handlers."""

import pytest
from starlette.requests import Request
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
async def test_sftp_list_event_emits_listing(reset_server_state):
    from torrus.server import on_sftp_list
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.list_directory = AsyncMock(return_value={"ok": True, "path": ".", "entries": []})

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_list("sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "."})

    server_module.sftp_manager.list_directory.assert_awaited_once_with("tab1", ".")
    sio_mock.emit.assert_awaited_once_with("sftp:list:result", {"tab_id": "tab1", "ok": True, "path": ".", "entries": []}, to="sid-1")


@pytest.mark.asyncio
async def test_sftp_list_event_returns_structured_error(reset_server_state):
    from torrus.server import on_sftp_list
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.list_directory = AsyncMock(
        side_effect=SFTPError("FILE_NOT_FOUND", "Directory not found: /missing")
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_list("sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "/missing"})

    sio_mock.emit.assert_awaited_once_with(
        "sftp:list:result",
        {"tab_id": "tab1", "ok": False, "code": "FILE_NOT_FOUND", "message": "Directory not found: /missing"},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_upload_event_decodes_base64(reset_server_state):
    from torrus.server import on_sftp_upload
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.upload_file = AsyncMock(return_value={"ok": True, "path": "x.txt", "size": 5})

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_upload("sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "x.txt", "data": "aGVsbG8="})

    server_module.sftp_manager.upload_file.assert_awaited_once_with("tab1", "x.txt", b"hello")
    sio_mock.emit.assert_awaited_once()


@pytest.mark.asyncio
async def test_sftp_error_event_on_missing_session(reset_server_state):
    from torrus.server import on_sftp_download
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.download_file = AsyncMock(
        side_effect=SFTPError("CONNECTION_CLOSED", "SSH connection lost. Reconnect to continue.")
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_download("sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "x.txt"})

    sio_mock.emit.assert_awaited_once_with(
        "sftp:error",
        {"tab_id": "tab1", "code": "CONNECTION_CLOSED", "message": "SSH connection lost. Reconnect to continue."},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_open_uses_source_tab_public_api(reset_server_state):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.open_sftp = AsyncMock(return_value=True)
    server_module.sftp_manager.list_directory = AsyncMock(return_value={"ok": True, "path": ".", "entries": []})
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(return_value=None)
    server_module.ssh_manager.is_root_session = AsyncMock(return_value=False)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open("sid-1", {"session_id": "sess1", "tab_id": "sftp-tab", "source_tab_id": "terminal-tab"})

    server_module.sftp_manager.open_sftp.assert_awaited_once_with(
        "sess1",
        "sftp-tab",
        server_module.ssh_manager,
        source_tab_id="terminal-tab",
    )
    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {"tab_id": "sftp-tab", "username": None, "is_root": False, "ok": True, "path": ".", "entries": []},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_open_includes_source_ssh_username(reset_server_state):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.open_sftp = AsyncMock(return_value=True)
    server_module.sftp_manager.list_directory = AsyncMock(return_value={"ok": True, "path": ".", "entries": []})
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(return_value=("server.example", 22, "deploy"))
    server_module.ssh_manager.is_root_session = AsyncMock(return_value=True)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open("sid-1", {"session_id": "sess1", "tab_id": "sftp-tab", "source_tab_id": "terminal-tab"})

    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {"tab_id": "sftp-tab", "username": "deploy", "is_root": True, "ok": True, "path": ".", "entries": []},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_open_continues_when_username_lookup_fails(reset_server_state):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.open_sftp = AsyncMock(return_value=True)
    server_module.sftp_manager.list_directory = AsyncMock(return_value={"ok": True, "path": ".", "entries": []})
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(side_effect=RuntimeError("session metadata unavailable"))
    server_module.ssh_manager.is_root_session = AsyncMock(side_effect=RuntimeError("session metadata unavailable"))

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open("sid-1", {"session_id": "sess1", "tab_id": "sftp-tab", "source_tab_id": "terminal-tab"})

    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {"tab_id": "sftp-tab", "username": None, "is_root": False, "ok": True, "path": ".", "entries": []},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_chmod_emits_success_result(reset_server_state):
    from torrus.server import on_sftp_chmod
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.chmod = AsyncMock(return_value={"ok": True, "path": "/tmp/x", "mode": 0o640})

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_chmod(
            "sid-1",
            {"session_id": "sess1", "tab_id": "tab1", "path": "/tmp/x", "mode": 0o640},
        )

    server_module.sftp_manager.chmod.assert_awaited_once_with("tab1", "/tmp/x", 0o640)
    sio_mock.emit.assert_awaited_once_with(
        "sftp:chmod:result",
        {"tab_id": "tab1", "ok": True, "path": "/tmp/x", "mode": 0o640},
        to="sid-1",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["777", -1, True, False])
async def test_sftp_chmod_rejects_invalid_mode(reset_server_state, mode):
    from torrus.server import on_sftp_chmod
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_chmod(
            "sid-1",
            {"session_id": "sess1", "tab_id": "tab1", "path": "/tmp/x", "mode": mode},
        )

    server_module.sftp_manager.chmod.assert_not_called()
    sio_mock.emit.assert_awaited_once_with(
        "sftp:chmod:result",
        {"tab_id": "tab1", "ok": False, "code": "invalid_request", "message": "Invalid permission mode."},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_accounts_emits_remote_users_and_groups(reset_server_state):
    from torrus.server import on_sftp_accounts
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.accounts = AsyncMock(
        return_value={
            "ok": True,
            "users": [{"uid": 1000, "name": "app"}],
            "groups": [{"gid": 1000, "name": "app"}],
        }
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_accounts("sid-1", {"session_id": "sess1", "tab_id": "tab1"})

    server_module.sftp_manager.accounts.assert_awaited_once_with("tab1")
    sio_mock.emit.assert_awaited_once_with(
        "sftp:accounts:result",
        {"tab_id": "tab1", "ok": True, "users": [{"uid": 1000, "name": "app"}], "groups": [{"gid": 1000, "name": "app"}]},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_close_closes_sftp_session(reset_server_state):
    from torrus.server import on_sftp_close
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.close_sftp = AsyncMock()

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_close("sid-1", {"session_id": "sess1", "tab_id": "sftp-tab"})

    server_module.sftp_manager.close_sftp.assert_awaited_once_with("sftp-tab")
    sio_mock.emit.assert_awaited_once_with(
        "sftp:close:result",
        {"tab_id": "sftp-tab", "ok": True},
        to="sid-1",
    )

@pytest.mark.asyncio
async def test_sftp_open_emits_connection_closed_when_channel_unavailable(reset_server_state):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.open_sftp = AsyncMock(return_value=False)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open("sid-1", {"session_id": "sess1", "tab_id": "sftp-tab", "source_tab_id": "terminal-tab"})

    server_module.sftp_manager.open_sftp.assert_awaited_once()
    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {"tab_id": "sftp-tab", "ok": False, "code": "CONNECTION_CLOSED"},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_delete_returns_partial_results(reset_server_state):
    from torrus.server import on_sftp_delete
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    async def delete(_tab_id, path):
        if path == "bad.txt":
            raise SFTPError("FILE_NOT_FOUND", "File not found: bad.txt")
        return {"ok": True, "path": path}

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.delete = AsyncMock(side_effect=delete)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_delete("sid-1", {"session_id": "sess1", "tab_id": "tab1", "paths": ["ok.txt", "bad.txt"]})

    sio_mock.emit.assert_awaited_once_with(
        "sftp:delete:result",
        {
            "tab_id": "tab1",
            "ok": False,
            "results": [
                {"ok": True, "path": "ok.txt"},
                {"ok": False, "path": "bad.txt", "code": "FILE_NOT_FOUND", "message": "File not found: bad.txt"},
            ],
        },
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_http_download_returns_error_before_stream(reset_server_state):
    from torrus.server import sftp_stream_download
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.has_session = AsyncMock(return_value=True)
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_download = AsyncMock(
        side_effect=SFTPError("FILE_NOT_FOUND", "File not found: missing.txt")
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/sftp/download",
            "query_string": b"session_id=sess1&tab_id=tab1&path=missing.txt",
            "headers": [],
        }
    )
    response = await sftp_stream_download(request)

    assert response.status_code == 404
    assert response.body == b'{"ok":false,"code":"FILE_NOT_FOUND","message":"File not found: missing.txt"}'
    server_module.sftp_manager.stream_download.assert_not_called()


@pytest.mark.asyncio
async def test_sftp_http_download_binds_tab_to_session(reset_server_state):
    from torrus.server import sftp_stream_download
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.has_session = AsyncMock(return_value=True)
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_download = AsyncMock(
        side_effect=SFTPError("PERMISSION_DENIED", "SFTP tab is not available for this session.")
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/sftp/download",
            "query_string": b"session_id=session-b&tab_id=tab-a&path=readme.txt",
            "headers": [],
        }
    )
    response = await sftp_stream_download(request)

    assert response.status_code == 403
    server_module.sftp_manager.prepare_download.assert_awaited_once_with(
        "tab-a", "readme.txt", expected_session_id="session-b"
    )
    server_module.sftp_manager.stream_download.assert_not_called()


@pytest.mark.asyncio
async def test_sftp_http_upload_binds_tab_to_session(reset_server_state):
    from torrus.server import sftp_stream_upload
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.has_session = AsyncMock(return_value=True)
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.upload_chunk = AsyncMock(
        side_effect=SFTPError("PERMISSION_DENIED", "SFTP tab is not available for this session.")
    )

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/sftp/upload",
            "query_string": b"session_id=session-b&tab_id=tab-a&path=x.txt&upload_id=upload1&offset=0&total=1",
            "headers": [],
        }
    )
    response = await sftp_stream_upload(request)

    assert response.status_code == 403
    call = server_module.sftp_manager.upload_chunk.await_args
    assert call.kwargs["expected_session_id"] == "session-b"
