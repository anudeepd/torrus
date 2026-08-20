"""Tests for SFTP bulk zip download (prepare_bulk_download + stream_bulk_zip)."""

from __future__ import annotations

import io
import zipfile

import pytest

from test_sftp_manager import FakeSFTP, FakeSSHManager


async def _read_zip(manager, tab_id, files):
    chunks = [chunk async for chunk in manager.stream_bulk_zip(tab_id, files)]
    return zipfile.ZipFile(io.BytesIO(b"".join(chunks)))


@pytest.mark.asyncio
async def test_bulk_zip_two_files_contains_correct_entries():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    sftp.fs["/home/app/readme.txt"] = b"hello"
    sftp.fs["/home/app/notes.txt"] = b"world"
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        prepared = await manager.prepare_bulk_download(
            "tab1", ["/home/app/readme.txt", "/home/app/notes.txt"]
        )
        archive = await _read_zip(manager, "tab1", prepared["files"])
    finally:
        await manager.shutdown()

    assert prepared["ok"] is True
    assert archive.namelist() == ["notes.txt", "readme.txt"]
    assert archive.read("readme.txt") == b"hello"
    assert archive.read("notes.txt") == b"world"
    assert archive.testzip() is None


@pytest.mark.asyncio
async def test_bulk_zip_directory_walks_nested_files():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    sftp.dirs.add("/home/app/projects")
    sftp.dirs.add("/home/app/projects/sub")
    sftp.fs["/home/app/projects/a.txt"] = b"a"
    sftp.fs["/home/app/projects/sub/b.txt"] = b"b"
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        prepared = await manager.prepare_bulk_download("tab1", ["/home/app/projects"])
        archive = await _read_zip(manager, "tab1", prepared["files"])
    finally:
        await manager.shutdown()

    assert archive.namelist() == ["projects/a.txt", "projects/sub/b.txt"]
    assert archive.read("projects/a.txt") == b"a"
    assert archive.read("projects/sub/b.txt") == b"b"


@pytest.mark.asyncio
async def test_bulk_zip_rejects_traversal_outside_home():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        with pytest.raises(SFTPError) as exc:
            await manager.prepare_bulk_download("tab1", ["../etc/passwd"])
    finally:
        await manager.shutdown()

    assert exc.value.code == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_bulk_zip_rejects_missing_path():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        with pytest.raises(SFTPError) as exc:
            await manager.prepare_bulk_download("tab1", ["missing.txt"])
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_bulk_download_endpoint_returns_zip(monkeypatch):
    import torrus.server as server_module
    from fastapi.testclient import TestClient
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    sftp.fs["/home/app/readme.txt"] = b"hello"
    sftp.fs["/home/app/notes.txt"] = b"world"
    manager = SFTPManager()
    await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
    monkeypatch.setattr(server_module, "sftp_manager", manager)
    try:
        client = TestClient(server_module.fastapi_app)
        response = client.post(
            "/sftp/bulk-download",
            json={
                "session_id": "sess1",
                "tab_id": "tab1",
                "paths": ["/home/app/readme.txt", "/home/app/notes.txt"],
            },
        )
    finally:
        await manager.shutdown()

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "attachment" in response.headers["content-disposition"]
    assert "torrus-bulk-" in response.headers["content-disposition"]
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.namelist() == ["notes.txt", "readme.txt"]
    assert archive.read("readme.txt") == b"hello"
    assert archive.read("notes.txt") == b"world"


@pytest.mark.asyncio
async def test_bulk_download_endpoint_rejects_traversal(monkeypatch):
    import torrus.server as server_module
    from fastapi.testclient import TestClient
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
    monkeypatch.setattr(server_module, "sftp_manager", manager)
    try:
        client = TestClient(server_module.fastapi_app)
        response = client.post(
            "/sftp/bulk-download",
            json={"session_id": "sess1", "tab_id": "tab1", "paths": ["../etc/passwd"]},
        )
    finally:
        await manager.shutdown()

    assert response.status_code == 403
    assert response.json()["code"] == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_bulk_download_endpoint_rejects_missing_path(monkeypatch):
    import torrus.server as server_module
    from fastapi.testclient import TestClient
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
    monkeypatch.setattr(server_module, "sftp_manager", manager)
    try:
        client = TestClient(server_module.fastapi_app)
        response = client.post(
            "/sftp/bulk-download",
            json={"session_id": "sess1", "tab_id": "tab1", "paths": ["missing.txt"]},
        )
    finally:
        await manager.shutdown()

    assert response.status_code == 404
    assert response.json()["code"] == "FILE_NOT_FOUND"