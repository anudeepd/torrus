"""Tests for SFTP Socket.IO event handlers."""

import posixpath

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
    server_module.sftp_manager.list_directory = AsyncMock(
        return_value={"ok": True, "path": ".", "entries": []}
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_list(
            "sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "."}
        )

    server_module.sftp_manager.list_directory.assert_awaited_once_with("tab1", ".")
    sio_mock.emit.assert_awaited_once_with(
        "sftp:list:result",
        {"tab_id": "tab1", "ok": True, "path": ".", "entries": []},
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_list_checks_source_ssh_tab_for_ldap_owner(reset_server_state):
    from torrus.server import on_sftp_list
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module._ldap_enabled = True
    server_module._authenticated_users["sid-1"] = "alice"
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.get_source_tab_id.return_value = "terminal-tab"
    server_module.sftp_manager.list_directory = AsyncMock(
        return_value={"ok": True, "path": "/target", "entries": []}
    )
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(
        return_value=("server.example", 22, "deploy")
    )

    with (
        patch("torrus.server.sio", sio_mock),
        patch.object(server_module, "_require_auth", AsyncMock(return_value=True)),
    ):
        await on_sftp_list(
            "sid-1",
            {"session_id": "sess1", "tab_id": "sftp-tab", "path": "/target"},
        )

    server_module.sftp_manager.get_source_tab_id.assert_called_once_with(
        "sftp-tab", expected_session_id="sess1"
    )
    server_module.ssh_manager.get_session_target.assert_awaited_once_with(
        "sess1", "terminal-tab", owner_ldap_username="alice"
    )
    server_module.sftp_manager.list_directory.assert_awaited_once_with(
        "sftp-tab", "/target"
    )
    sio_mock.emit.assert_awaited_once_with(
        "sftp:list:result",
        {"tab_id": "sftp-tab", "ok": True, "path": "/target", "entries": []},
        to="sid-1",
    )


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
        await on_sftp_list(
            "sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "/missing"}
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:list:result",
        {
            "tab_id": "tab1",
            "ok": False,
            "code": "FILE_NOT_FOUND",
            "message": "Directory not found: /missing",
        },
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_error_event_on_missing_session(reset_server_state):
    from torrus.server import on_sftp_download
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.download_file = AsyncMock(
        side_effect=SFTPError(
            "CONNECTION_CLOSED", "SSH connection lost. Reconnect to continue."
        )
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_download(
            "sid-1", {"session_id": "sess1", "tab_id": "tab1", "path": "x.txt"}
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:error",
        {
            "tab_id": "tab1",
            "code": "CONNECTION_CLOSED",
            "message": "SSH connection lost. Reconnect to continue.",
            "operation": "download",
        },
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_mkdir_error_identifies_operation(reset_server_state):
    from torrus.server import on_sftp_mkdir
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.mkdir = AsyncMock(
        side_effect=SFTPError("PERMISSION_DENIED", "Permission denied: /srv/app/new")
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_mkdir(
            "sid-1",
            {"session_id": "sess1", "tab_id": "tab1", "path": "/srv/app/new"},
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:error",
        {
            "tab_id": "tab1",
            "code": "PERMISSION_DENIED",
            "message": "Permission denied: /srv/app/new",
            "operation": "mkdir",
        },
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
    server_module.sftp_manager.list_directory = AsyncMock(
        return_value={"ok": True, "path": ".", "entries": []}
    )
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(return_value=None)
    server_module.ssh_manager.is_root_session = AsyncMock(return_value=False)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
            },
        )

    server_module.sftp_manager.open_sftp.assert_awaited_once_with(
        "sess1",
        "sftp-tab",
        server_module.ssh_manager,
        source_tab_id="terminal-tab",
    )
    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {
            "tab_id": "sftp-tab",
            "username": None,
            "is_root": False,
            "ok": True,
            "path": ".",
            "entries": [],
        },
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
    server_module.sftp_manager.list_directory = AsyncMock(
        return_value={"ok": True, "path": ".", "entries": []}
    )
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(
        return_value=("server.example", 22, "deploy")
    )
    server_module.ssh_manager.is_root_session = AsyncMock(return_value=True)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
            },
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {
            "tab_id": "sftp-tab",
            "username": "deploy",
            "is_root": True,
            "ok": True,
            "path": ".",
            "entries": [],
        },
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
    server_module.sftp_manager.list_directory = AsyncMock(
        return_value={"ok": True, "path": ".", "entries": []}
    )
    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.get_session_target = AsyncMock(
        side_effect=RuntimeError("session metadata unavailable")
    )
    server_module.ssh_manager.is_root_session = AsyncMock(
        side_effect=RuntimeError("session metadata unavailable")
    )

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
            },
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {
            "tab_id": "sftp-tab",
            "username": None,
            "is_root": False,
            "ok": True,
            "path": ".",
            "entries": [],
        },
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_sftp_chmod_emits_success_result(reset_server_state):
    from torrus.server import on_sftp_chmod
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.chmod = AsyncMock(
        return_value={"ok": True, "path": "/tmp/x", "mode": 0o640}
    )

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
        {
            "tab_id": "tab1",
            "ok": False,
            "code": "invalid_request",
            "message": "Invalid permission mode.",
        },
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
        {
            "tab_id": "tab1",
            "ok": True,
            "users": [{"uid": 1000, "name": "app"}],
            "groups": [{"gid": 1000, "name": "app"}],
        },
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
async def test_sftp_open_emits_connection_closed_when_channel_unavailable(
    reset_server_state,
):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.open_sftp = AsyncMock(return_value=False)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
            },
        )

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
        await on_sftp_delete(
            "sid-1",
            {"session_id": "sess1", "tab_id": "tab1", "paths": ["ok.txt", "bad.txt"]},
        )

    sio_mock.emit.assert_awaited_once_with(
        "sftp:delete:result",
        {
            "tab_id": "tab1",
            "ok": False,
            "results": [
                {"ok": True, "path": "ok.txt"},
                {
                    "ok": False,
                    "path": "bad.txt",
                    "code": "FILE_NOT_FOUND",
                    "message": "File not found: bad.txt",
                },
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
    assert (
        response.body
        == b'{"ok":false,"code":"FILE_NOT_FOUND","message":"File not found: missing.txt"}'
    )
    server_module.sftp_manager.stream_download.assert_not_called()


@pytest.mark.asyncio
async def test_sftp_http_download_reports_stream_size(reset_server_state):
    from torrus.server import sftp_stream_download
    import torrus.server as server_module

    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.has_session = AsyncMock(return_value=True)
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_download = AsyncMock(
        return_value={
            "path": "/srv/archive.tar",
            "name": "archive.tar",
            "size": 12 * 1024**3,
        }
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/sftp/download",
            "query_string": b"session_id=sess1&tab_id=tab1&path=archive.tar",
            "headers": [],
        }
    )
    response = await sftp_stream_download(request)

    assert response.headers["content-length"] == str(12 * 1024**3)
    server_module.sftp_manager.stream_download.assert_called_once_with(
        "tab1", "/srv/archive.tar", expected_session_id="sess1"
    )


@pytest.mark.asyncio
async def test_sftp_http_download_binds_tab_to_session(reset_server_state):
    from torrus.server import sftp_stream_download
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    server_module.ssh_manager = MagicMock()
    server_module.ssh_manager.has_session = AsyncMock(return_value=True)
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_download = AsyncMock(
        side_effect=SFTPError(
            "PERMISSION_DENIED", "SFTP tab is not available for this session."
        )
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


class _RecordingSink:
    def __init__(self):
        self.data = bytearray()
        self.finalized = False
        self.aborted = False

    async def write_at(self, offset, data):
        end = offset + len(data)
        if end > len(self.data):
            self.data.extend(b"\x00" * (end - len(self.data)))
        self.data[offset:end] = data

    async def finalize(self):
        self.finalized = True

    async def abort(self):
        self.aborted = True


class _FakeSFTPManager:
    """Records how the engine bound the request to a tab and a session."""

    def __init__(self, sink):
        self.sink = sink
        self.resolve_calls = []
        self.sink_calls = []

    async def session_target(self, tab_id):
        return ("ssh.example.com", 22, "demo")

    def resolve_upload_path(self, tab_id, remote_path, expected_session_id=None):
        self.resolve_calls.append((tab_id, remote_path, expected_session_id))
        return posixpath.normpath(remote_path)

    async def open_upload_sink(
        self, tab_id, upload_id, directory, filename, ssh_manager, expected_session_id=None
    ):
        self.sink_calls.append(
            (tab_id, upload_id, directory, filename, expected_session_id)
        )
        return self.sink


@pytest.mark.asyncio
async def test_http_upload_runs_through_the_engine_and_binds_tab_to_session(
    reset_server_state, monkeypatch
):
    import torrus.server as server_module
    from fastapi.testclient import TestClient

    sink = _RecordingSink()
    manager = _FakeSFTPManager(sink)
    monkeypatch.setattr(server_module, "sftp_manager", manager)

    client = TestClient(server_module.fastapi_app)
    params = {"session_id": "session-b", "tab_id": "tab-a"}

    init = client.post(
        "/_upload/init",
        params=params,
        json={"filename": "x.txt", "size": 6, "dir": "/home/app"},
    )
    assert init.status_code == 200, init.text
    upload_id = init.json()["upload_id"]
    assert manager.resolve_calls == [("tab-a", "/home/app/x.txt", "session-b")]

    put = client.put(f"/_upload/{upload_id}", params={**params, "offset": 3}, content=b"def")
    assert put.status_code == 200, put.text
    put = client.put(f"/_upload/{upload_id}", params={**params, "offset": 0}, content=b"abc")
    assert put.status_code == 200, put.text

    done = client.post(f"/_upload/{upload_id}/complete", params=params)
    assert done.status_code == 200, done.text
    assert done.json()["path"] == "x.txt"
    assert bytes(sink.data) == b"abcdef"
    assert sink.finalized
    assert manager.sink_calls == [
        ("tab-a", upload_id, "/home/app", "x.txt", "session-b")
    ]


@pytest.mark.asyncio
async def test_http_upload_rejects_malformed_session_or_tab_ids(reset_server_state):
    import torrus.server as server_module
    from fastapi.testclient import TestClient

    client = TestClient(server_module.fastapi_app)
    for params in (
        {"session_id": "", "tab_id": "tab-a"},
        {"session_id": "session-b", "tab_id": ""},
        {"session_id": "../etc", "tab_id": "tab-a"},
    ):
        response = client.post(
            "/_upload/init",
            params=params,
            json={"filename": "x.txt", "size": 1, "dir": "/home/app"},
        )
        assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_http_upload_audits_one_row_for_the_remote_path(
    reset_server_state, monkeypatch
):
    import torrus.server as server_module
    from fastapi.testclient import TestClient

    sink = _RecordingSink()
    manager = _FakeSFTPManager(sink)
    recorded = AsyncMock()
    monkeypatch.setattr(server_module, "sftp_manager", manager)
    monkeypatch.setattr(server_module, "_ldap_enabled", True)
    monkeypatch.setattr(server_module, "_http_owner", lambda request: "alice")
    monkeypatch.setattr(
        server_module, "_sftp_session_owned", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        server_module.audit_store, "record_sftp_event", recorded
    )

    client = TestClient(server_module.fastapi_app)
    params = {"session_id": "session-b", "tab_id": "tab-a"}
    upload_id = client.post(
        "/_upload/init",
        params=params,
        json={"filename": "big.bin", "size": 4, "dir": "/home/app"},
    ).json()["upload_id"]
    client.put(f"/_upload/{upload_id}", params={**params, "offset": 0}, content=b"data")
    assert client.post(f"/_upload/{upload_id}/complete", params=params).status_code == 200

    recorded.assert_awaited_once()
    assert recorded.await_args.kwargs["path"] == "/home/app/big.bin"
    assert recorded.await_args.kwargs["size"] == 4
    assert recorded.await_args.kwargs["operation"] == "upload"
    assert recorded.await_args.kwargs["ldap_username"] == "alice"


@pytest.mark.asyncio
async def test_http_upload_requires_an_owned_tab_when_ldap_is_enabled(
    reset_server_state, monkeypatch
):
    import torrus.server as server_module
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_module, "_ldap_enabled", True)
    monkeypatch.setattr(server_module, "_http_owner", lambda request: "alice")
    monkeypatch.setattr(
        server_module, "_sftp_session_owned", AsyncMock(return_value=False)
    )

    client = TestClient(server_module.fastapi_app)
    response = client.post(
        "/_upload/init",
        params={"session_id": "session-b", "tab_id": "tab-a"},
        json={"filename": "x.txt", "size": 1, "dir": "/home/app"},
    )

    assert response.status_code == 403
    server_module._sftp_session_owned.assert_awaited_once_with(
        "session-b", "tab-a", "alice"
    )


@pytest.mark.asyncio
async def test_sftp_mkdirs_event_creates_the_tree_and_audits_it(reset_server_state):
    from torrus.server import on_sftp_mkdirs
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_upload_directories = AsyncMock(
        return_value={"ok": True, "created": ["/home/app/trip/photos"]}
    )
    audited = AsyncMock()

    with (
        patch("torrus.server.sio", sio_mock),
        patch.object(server_module, "_record_sftp_events_audit", audited),
    ):
        await on_sftp_mkdirs(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "tab1",
                "paths": ["trip", "trip/photos"],
                "request_id": "req1",
            },
        )

    server_module.sftp_manager.prepare_upload_directories.assert_awaited_once_with(
        "tab1", ["trip", "trip/photos"], expected_session_id="sess1"
    )
    sio_mock.emit.assert_awaited_once_with(
        "sftp:mkdirs:result",
        {
            "tab_id": "tab1",
            "request_id": "req1",
            "ok": True,
            "created": ["/home/app/trip/photos"],
        },
        to="sid-1",
    )
    assert audited.await_args.kwargs["operation"] == "mkdir"
    assert audited.await_args.kwargs["entries"] == [("/home/app/trip/photos", 0, "")]


@pytest.mark.asyncio
async def test_sftp_mkdirs_event_rejects_a_malformed_folder_list(reset_server_state):
    from torrus.server import on_sftp_mkdirs
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_upload_directories = AsyncMock()

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_mkdirs(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "tab1",
                "paths": ["ok", 7],
                "request_id": "req1",
            },
        )

    server_module.sftp_manager.prepare_upload_directories.assert_not_called()
    assert sio_mock.emit.await_args.args[1]["code"] == "invalid_request"


@pytest.mark.asyncio
async def test_sftp_mkdirs_event_requires_a_known_request_id(reset_server_state):
    from torrus.server import on_sftp_mkdirs
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    server_module.sftp_manager = MagicMock()
    server_module.sftp_manager.prepare_upload_directories = AsyncMock()

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_mkdirs(
            "sid-1",
            {"session_id": "sess1", "tab_id": "tab1", "paths": ["trip"]},
        )

    server_module.sftp_manager.prepare_upload_directories.assert_not_called()
    sio_mock.emit.assert_not_awaited()


def _open_test_server(server_module, list_directory):
    import torrus.server as server_module_local

    server_module_local.sftp_manager = MagicMock()
    server_module_local.sftp_manager.open_sftp = AsyncMock(return_value=True)
    server_module_local.sftp_manager.list_directory = list_directory
    server_module_local.ssh_manager = MagicMock()
    server_module_local.ssh_manager.get_session_target = AsyncMock(return_value=None)
    server_module_local.ssh_manager.is_root_session = AsyncMock(return_value=False)


@pytest.mark.asyncio
async def test_sftp_open_lists_the_path_remembered_by_the_client(reset_server_state):
    from torrus.server import on_sftp_open
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    list_directory = AsyncMock(return_value={"ok": True, "path": "/srv/app", "entries": []})
    _open_test_server(server_module, list_directory)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
                "path": "/srv/app",
            },
        )

    list_directory.assert_awaited_once_with("sftp-tab", "/srv/app")
    assert sio_mock.emit.await_args.args[1]["path"] == "/srv/app"


@pytest.mark.asyncio
async def test_sftp_open_falls_back_to_home_when_the_remembered_path_is_gone(
    reset_server_state,
):
    from torrus.server import on_sftp_open
    from torrus.sftp_manager import SFTPError
    import torrus.server as server_module

    sio_mock = MagicMock()
    sio_mock.emit = AsyncMock()
    list_directory = AsyncMock(
        side_effect=[
            SFTPError("NO_SUCH_FILE", "No such file: /srv/gone"),
            {"ok": True, "path": ".", "entries": []},
        ]
    )
    _open_test_server(server_module, list_directory)

    with patch("torrus.server.sio", sio_mock):
        await on_sftp_open(
            "sid-1",
            {
                "session_id": "sess1",
                "tab_id": "sftp-tab",
                "source_tab_id": "terminal-tab",
                "path": "/srv/gone",
            },
        )

    assert [call.args[1] for call in list_directory.await_args_list] == ["/srv/gone", "."]
    sio_mock.emit.assert_awaited_once_with(
        "sftp:open:result",
        {
            "tab_id": "sftp-tab",
            "username": None,
            "is_root": False,
            "ok": True,
            "path": ".",
            "entries": [],
        },
        to="sid-1",
    )
