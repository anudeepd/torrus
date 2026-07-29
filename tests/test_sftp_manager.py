"""Tests for SFTP manager operations."""

from __future__ import annotations

import asyncio
import errno
from types import SimpleNamespace

import pytest


class FakeRemoteFile:
    def __init__(
        self,
        fs: dict[str, bytes],
        path: str,
        mode: str,
        close_error: Exception | None = None,
    ):
        self.fs = fs
        self.path = path
        self.mode = mode
        self.buffer = b"" if "w" in mode else fs.get(path, b"")
        self.position = 0
        self.pipelined = False
        self.close_error = close_error

    def write(self, data: bytes) -> None:
        self.buffer = (
            self.buffer[: self.position]
            + data
            + self.buffer[self.position + len(data) :]
        )
        self.position += len(data)

    def seek(self, offset: int) -> None:
        self.position = offset

    def set_pipelined(self, pipelined: bool) -> None:
        self.pipelined = pipelined

    def read(self, size: int | None = None) -> bytes:
        if size is None:
            size = len(self.buffer)
        chunk = self.buffer[:size]
        self.buffer = self.buffer[size:]
        return chunk

    def close(self) -> None:
        if self.close_error is not None:
            raise self.close_error
        if "w" in self.mode or "+" in self.mode:
            self.fs[self.path] = self.buffer

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class FakeSFTP:
    def __init__(self):
        self.fs: dict[str, bytes] = {
            "/home/app/readme.txt": b"hello",
            "/etc/passwd": b"app:x:1000:1000:App User:/home/app:/bin/bash\nsvc:x:1001:1001:Svc:/home/svc:/bin/bash\n",
            "/etc/group": b"app:x:1000:\nsvc:x:1002:\n",
        }
        self.dirs = {"/home/app"}
        self.cwd = "/home/app"
        self.modes: dict[str, int] = {}
        self.owners: dict[str, tuple[int, int]] = {}
        self.closed = False
        self.close_count = 0
        self.next_file_close_error: Exception | None = None
        self.last_file: FakeRemoteFile | None = None

    def chdir(self, path: str) -> None:
        if path == ".":
            return
        self.cwd = path

    def getcwd(self) -> str:
        return self.cwd

    def listdir_attr(self, path: str):
        if path == ".":
            path = self.cwd
        if path == "/missing":
            raise FileNotFoundError(errno.ENOENT, "missing", path)
        prefix = path.rstrip("/") + "/"
        names = []
        for directory in self.dirs:
            if directory.startswith(prefix):
                rest = directory[len(prefix) :]
                if rest and "/" not in rest:
                    uid, gid = self.owners.get(directory, (1000, 1000))
                    names.append(
                        SimpleNamespace(
                            filename=rest,
                            st_mode=0o040755,
                            st_size=0,
                            st_mtime=1,
                            st_uid=uid,
                            st_gid=gid,
                        )
                    )
        for file_path, data in self.fs.items():
            if file_path.startswith(prefix):
                rest = file_path[len(prefix) :]
                if rest and "/" not in rest:
                    uid, gid = self.owners.get(file_path, (1000, 1000))
                    names.append(
                        SimpleNamespace(
                            filename=rest,
                            st_mode=0o100644,
                            st_size=len(data),
                            st_mtime=2,
                            st_uid=uid,
                            st_gid=gid,
                        )
                    )
        return names

    def open(self, path: str, mode: str):
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        if "r" in mode and path not in self.fs:
            raise FileNotFoundError(errno.ENOENT, "missing", path)
        close_error = self.next_file_close_error
        self.next_file_close_error = None
        self.last_file = FakeRemoteFile(self.fs, path, mode, close_error=close_error)
        return self.last_file

    def lstat(self, path: str):
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        if path in self.dirs:
            return SimpleNamespace(st_mode=0o040755, st_size=0)
        if path in self.fs:
            return SimpleNamespace(st_mode=0o100644, st_size=len(self.fs[path]))
        raise FileNotFoundError(errno.ENOENT, "missing", path)

    def stat(self, path: str):
        return self.lstat(path)

    def remove(self, path: str) -> None:
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        del self.fs[path]

    def rmdir(self, path: str) -> None:
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        self.dirs.remove(path)

    def rename(self, old_path: str, new_path: str) -> None:
        if not old_path.startswith("/"):
            old_path = f"{self.cwd.rstrip('/')}/{old_path}"
        if not new_path.startswith("/"):
            new_path = f"{self.cwd.rstrip('/')}/{new_path}"
        self.fs[new_path] = self.fs.pop(old_path)

    def mkdir(self, path: str) -> None:
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        self.dirs.add(path)

    def chmod(self, path: str, mode: int) -> None:
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        if path not in self.fs and path not in self.dirs:
            raise FileNotFoundError(errno.ENOENT, "missing", path)
        self.modes[path] = mode

    def chown(self, path: str, uid: int, gid: int) -> None:
        if not path.startswith("/"):
            path = f"{self.cwd.rstrip('/')}/{path}"
        if path not in self.fs and path not in self.dirs:
            raise FileNotFoundError(errno.ENOENT, "missing", path)
        self.owners[path] = (uid, gid)

    def close(self) -> None:
        self.closed = True
        self.close_count += 1


class FakeSSHManager:
    def __init__(self, sftp: FakeSFTP | None):
        self.sftp = sftp
        self.opened_tab_id = None

    async def open_sftp_channel(self, _session_id: str, tab_id: str):
        self.opened_tab_id = tab_id
        return self.sftp


class QueueSSHManager:
    def __init__(self, clients):
        self.clients = list(clients)

    async def open_sftp_channel(self, _session_id: str, _tab_id: str):
        return self.clients.pop(0)


@pytest.mark.asyncio
async def test_list_directory_returns_sorted_schema():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        assert await manager.open_sftp("sess1", "tab1", ssh_manager)
        result = await manager.list_directory("tab1", ".")
    finally:
        await manager.shutdown()

    assert result["ok"] is True
    assert result["path"] == "/home/app"
    assert result["entries"][0]["name"] == "readme.txt"
    assert result["entries"][0]["type"] == "file"
    assert result["entries"][0]["uid"] == 1000
    assert result["entries"][0]["gid"] == 1000
    assert result["entries"][0]["owner"] == "app"
    assert result["entries"][0]["group"] == "app"


@pytest.mark.asyncio
async def test_accounts_returns_remote_users_and_groups():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    try:
        assert await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        result = await manager.accounts("tab1")
    finally:
        await manager.shutdown()

    assert {"uid": 1000, "name": "app"} in result["users"]
    assert {"gid": 1002, "name": "svc"} in result["groups"]


@pytest.mark.asyncio
async def test_open_sftp_uses_source_tab_without_private_state_move():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        assert await manager.open_sftp(
            "sess1", "sftp-tab", ssh_manager, source_tab_id="terminal-tab"
        )
    finally:
        await manager.shutdown()

    assert ssh_manager.opened_tab_id == "terminal-tab"


@pytest.mark.asyncio
async def test_upload_download_rename_delete_and_mkdir():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        upload = await manager.upload_file("tab1", "new.txt", b"new")
        assert upload["size"] == 3
        download = await manager.download_file("tab1", "new.txt")
        assert download["data"] == "bmV3"
        renamed = await manager.rename("tab1", "new.txt", "renamed.txt")
        assert renamed["new_path"] == "/home/app/renamed.txt"
        made = await manager.mkdir("tab1", "docs")
        assert made["path"] == "/home/app/docs"
        changed = await manager.chmod("tab1", "docs", 0o750)
        assert changed == {"ok": True, "path": "/home/app/docs", "mode": 0o750}
        owned = await manager.chown("tab1", "docs", 1001, 1002)
        assert owned == {"ok": True, "path": "/home/app/docs", "uid": 1001, "gid": 1002}
        deleted = await manager.delete("tab1", "renamed.txt")
        assert deleted["ok"] is True
    finally:
        await manager.shutdown()

    assert "/home/app/renamed.txt" not in sftp.fs
    assert sftp.modes["/home/app/docs"] == 0o750
    assert sftp.owners["/home/app/docs"] == (1001, 1002)


@pytest.mark.asyncio
async def test_missing_file_maps_to_file_not_found():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        with pytest.raises(SFTPError) as exc:
            await manager.download_file("tab1", "missing.txt")
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_nonempty_directory_delete_reports_actionable_error():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    sftp.dirs.add("/home/app/full")
    sftp.fs["/home/app/full/child.txt"] = b"content"

    def reject_nonempty_directory(_path: str) -> None:
        raise OSError("Failure")

    sftp.rmdir = reject_nonempty_directory
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        with pytest.raises(SFTPError) as exc:
            await manager.delete("tab1", "full")
    finally:
        await manager.shutdown()

    assert exc.value.code == "DIRECTORY_NOT_EMPTY"
    assert exc.value.message == "Directory is not empty: /home/app/full"


@pytest.mark.asyncio
async def test_chmod_missing_file_maps_to_file_not_found():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        with pytest.raises(SFTPError) as exc:
            await manager.chmod("tab1", "missing.txt", 0o640)
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_chown_missing_file_maps_to_file_not_found():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", FakeSSHManager(sftp))
        with pytest.raises(SFTPError) as exc:
            await manager.chown("tab1", "missing.txt", 1000, 1000)
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_NOT_FOUND"


def test_connection_closed_maps_from_errno_not_only_message():
    from torrus.sftp_manager import _map_error

    exc = OSError(errno.ECONNRESET, "localized transport failure")

    assert _map_error(exc, "/tmp/x").code == "CONNECTION_CLOSED"


@pytest.mark.asyncio
async def test_prepare_download_errors_before_streaming_headers():
    from torrus.sftp_manager import SFTPError, SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        ready = await manager.prepare_download("tab1", "readme.txt")
        with pytest.raises(SFTPError) as exc:
            await manager.prepare_download("tab1", "missing.txt")
    finally:
        await manager.shutdown()

    assert ready["path"] == "/home/app/readme.txt"
    assert ready["name"] == "readme.txt"
    assert exc.value.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_tilde_resolves_to_home_directory():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    sftp.fs["/home/app/from-home.txt"] = b"home"
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        await manager.list_directory("tab1", "/tmp")
        download = await manager.download_file("tab1", "~/from-home.txt")
    finally:
        await manager.shutdown()

    assert download["path"] == "/home/app/from-home.txt"


@pytest.mark.asyncio
async def test_run_blocking_uses_executor_without_polling(monkeypatch):
    from torrus.sftp_manager import SFTPManager

    async def fail_sleep(_seconds):
        raise AssertionError("_run_blocking must await the executor instead of polling")

    manager = SFTPManager()
    monkeypatch.setattr(asyncio, "sleep", fail_sleep)
    try:
        result = await manager._run_blocking(lambda: "ok")
    finally:
        await manager.shutdown()

    assert result == "ok"


@pytest.mark.asyncio
async def test_stream_upload_enforces_max_bytes():
    from torrus.sftp_manager import SFTPError, SFTPManager

    async def chunks():
        yield b"abc"
        yield b"def"

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        with pytest.raises(SFTPError) as exc:
            await manager.stream_upload("tab1", "too-big.txt", chunks(), max_bytes=5)
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_TOO_LARGE"
    assert "/home/app/too-big.txt" not in sftp.fs


@pytest.mark.asyncio
async def test_stream_upload_size_error_survives_close_failure():
    from torrus.sftp_manager import SFTPError, SFTPManager

    async def chunks():
        yield b"abc"
        yield b"def"

    sftp = FakeSFTP()
    sftp.next_file_close_error = OSError("Socket is closed")
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        with pytest.raises(SFTPError) as exc:
            await manager.stream_upload("tab1", "too-big.txt", chunks(), max_bytes=5)
    finally:
        await manager.shutdown()

    assert exc.value.code == "FILE_TOO_LARGE"
    assert "/home/app/too-big.txt" not in sftp.fs


@pytest.mark.asyncio
async def test_upload_chunk_retries_and_only_replaces_target_when_complete():
    from torrus.sftp_manager import SFTPManager

    async def first_chunk():
        yield b"abc"

    async def final_chunk():
        yield b"def"

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        await manager.upload_chunk(
            "tab1", "readme.txt", "upload1", 0, 6, first_chunk(), False
        )
        await manager.upload_chunk(
            "tab1", "readme.txt", "upload1", 0, 6, first_chunk(), False
        )
        assert sftp.fs["/home/app/readme.txt"] == b"hello"
        assert sftp.fs["/home/app/.readme.txt.torrus-upload-upload1"] == b"abc"

        result = await manager.upload_chunk(
            "tab1", "readme.txt", "upload1", 3, 6, final_chunk(), True
        )
    finally:
        await manager.shutdown()

    assert result == {
        "ok": True,
        "path": "/home/app/readme.txt",
        "offset": 6,
        "complete": True,
    }
    assert sftp.fs["/home/app/readme.txt"] == b"abcdef"
    assert "/home/app/.readme.txt.torrus-upload-upload1" not in sftp.fs
    assert sftp.last_file is not None and sftp.last_file.pipelined


@pytest.mark.asyncio
async def test_expected_session_id_blocks_cross_session_tab_access():
    from torrus.sftp_manager import SFTPError, SFTPManager

    async def chunks():
        yield b"ok"

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("session-a", "tab1", ssh_manager)
        with pytest.raises(SFTPError) as upload_exc:
            await manager.stream_upload(
                "tab1", "x.txt", chunks(), max_bytes=10, expected_session_id="session-b"
            )
        with pytest.raises(SFTPError) as download_exc:
            await manager.prepare_download(
                "tab1", "readme.txt", expected_session_id="session-b"
            )
    finally:
        await manager.shutdown()

    assert upload_exc.value.code == "PERMISSION_DENIED"
    assert download_exc.value.code == "PERMISSION_DENIED"
    assert "/home/app/x.txt" not in sftp.fs


@pytest.mark.asyncio
async def test_concurrent_open_sftp_closes_superseded_client():
    from torrus.sftp_manager import SFTPManager

    first = FakeSFTP()
    second = FakeSFTP()
    ssh_manager = QueueSSHManager([first, second])
    manager = SFTPManager()
    try:
        await asyncio.gather(
            manager.open_sftp("sess1", "tab1", ssh_manager),
            manager.open_sftp("sess1", "tab1", ssh_manager),
        )
    finally:
        await manager.shutdown()

    assert first.close_count == 1
    assert second.close_count == 1


@pytest.mark.asyncio
async def test_stream_download_releases_tab_lock_between_chunks():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    sftp.fs["/home/app/big.txt"] = b"abcdef"
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        download = manager.stream_download("tab1", "big.txt", chunk_size=3)
        first_chunk = await anext(download)
        listing = await asyncio.wait_for(manager.list_directory("tab1", "."), timeout=1)
        second_chunk = await anext(download)
        with pytest.raises(StopAsyncIteration):
            await anext(download)
    finally:
        await manager.shutdown()

    assert first_chunk == b"abc"
    assert second_chunk == b"def"
    assert listing["ok"] is True


@pytest.mark.asyncio
async def test_stream_download_maps_midstream_disconnect_to_interrupted():
    from torrus.sftp_manager import SFTPError, SFTPManager

    class InterruptingFile(FakeRemoteFile):
        def read(self, size: int | None = None) -> bytes:
            if self.buffer == b"def":
                raise OSError("Socket is closed")
            return super().read(size)

    class InterruptingSFTP(FakeSFTP):
        def open(self, path: str, mode: str):
            if not path.startswith("/"):
                path = f"{self.cwd.rstrip('/')}/{path}"
            return InterruptingFile(self.fs, path, mode)

    sftp = InterruptingSFTP()
    sftp.fs["/home/app/big.txt"] = b"abcdef"
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        download = manager.stream_download("tab1", "big.txt", chunk_size=3)
        first_chunk = await anext(download)
        with pytest.raises(SFTPError) as exc:
            await anext(download)
    finally:
        await manager.shutdown()

    assert first_chunk == b"abc"
    assert exc.value.code == "DOWNLOAD_INTERRUPTED"


@pytest.mark.asyncio
async def test_run_blocking_closes_fds_when_add_reader_fails(monkeypatch):
    from torrus.sftp_manager import SFTPManager

    closed: list[int] = []

    def track_close(fd: int) -> None:
        closed.append(fd)
        real_close(fd)

    manager = SFTPManager()
    loop = asyncio.get_running_loop()
    real_close = __import__("os").close
    monkeypatch.setattr(
        loop,
        "add_reader",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("closing")),
    )
    monkeypatch.setattr("os.close", track_close)
    try:
        with pytest.raises(RuntimeError):
            await manager._run_blocking(lambda: "ok")
    finally:
        await manager.shutdown()

    assert len(closed) == 2


@pytest.mark.asyncio
async def test_stream_download_yields_chunks():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    ssh_manager = FakeSSHManager(sftp)
    manager = SFTPManager()
    try:
        await manager.open_sftp("sess1", "tab1", ssh_manager)
        chunks = [
            chunk
            async for chunk in manager.stream_download(
                "tab1", "readme.txt", chunk_size=2
            )
        ]
    finally:
        await manager.shutdown()

    assert chunks == [b"he", b"ll", b"o"]


@pytest.mark.asyncio
async def test_ssh_disconnect_cleans_matching_sftp_sessions():
    from torrus.sftp_manager import SFTPManager

    sftp = FakeSFTP()
    manager = SFTPManager()
    manager._sessions["tab1"] = SimpleNamespace(
        session_id="sess1", tab_id="tab1", client=sftp, cwd="/home/app"
    )
    manager._locks["tab1"] = asyncio.Lock()

    await manager.on_ssh_disconnect("sess1")

    assert "tab1" not in manager._sessions
    assert sftp.closed is True
