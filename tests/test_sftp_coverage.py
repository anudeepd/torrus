"""Coverage for SFTP paths not exercised by the behavioral suites."""

from __future__ import annotations

import asyncio
import errno
import os
import stat
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from test_sftp_manager import FakeSFTP, FakeSSHManager

from torrus import sftp_manager as module
from torrus.sftp_manager import (
    SFTPError,
    SFTPManager,
    SFTPSession,
    SFTPSink,
    _dedupe_arcname,
    _is_connection_closed,
    _map_error,
    _next_or_sentinel,
    _parse_group,
    _parse_passwd,
    _read_remote_text,
    _resolve_remote_path,
    _sink_error,
    _SpooledZipWriter,
    _TabLock,
    _TabLockScope,
)


def session_for(sftp=None, **overrides) -> SFTPSession:
    values = {
        "session_id": "sess1",
        "tab_id": "tab1",
        "client": sftp or FakeSFTP(),
        "cwd": "/home/app",
        "home": "/home/app",
    }
    values.update(overrides)
    return SFTPSession(**values)


@pytest.mark.asyncio
async def test_channel_stderr_tolerates_a_broken_channel():
    channel = MagicMock()
    channel.recv_stderr_ready.side_effect = RuntimeError("closed")
    assert module._channel_stderr(channel) == ""


@pytest.mark.asyncio
async def test_tab_lock_scope_releases_when_acquire_is_cancelled():
    locks: dict[str, _TabLock] = {}

    class CancelledLock:
        async def acquire(self):
            raise asyncio.CancelledError()

        def locked(self):
            return False

    locks["tab"] = _TabLock()
    locks["tab"].lock = CancelledLock()
    scope = _TabLockScope(locks, "tab")
    with pytest.raises(asyncio.CancelledError):
        await scope.__aenter__()
    assert "tab" not in locks


@pytest.mark.asyncio
async def test_sink_dead_state_and_missing_transport():
    client = FakeSFTP()
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    assert sink.destination == "/home/app/file.txt"

    sink._closed = True
    with pytest.raises(module.UploadSinkError, match="finished"):
        sink._raise_if_dead()
    sink._closed = False
    sink._failure = module.UploadSinkError("broken")
    with pytest.raises(module.UploadSinkError, match="broken"):
        sink._raise_if_dead()

    sink._failure = None
    client.get_channel = lambda: None
    with pytest.raises(module.UploadSinkError, match="connection lost"):
        await sink._open_channel()
    client.get_channel = lambda: SimpleNamespace(
        get_transport=lambda: SimpleNamespace(is_active=lambda: False)
    )
    with pytest.raises(module.UploadSinkError, match="connection lost"):
        await sink._open_channel()


@pytest.mark.asyncio
async def test_sink_open_channel_reports_an_exec_failure():
    client = FakeSFTP()
    transport = MagicMock()
    transport.is_active.return_value = True
    transport.open_session.side_effect = PermissionError("denied")
    client.get_channel = lambda: SimpleNamespace(get_transport=lambda: transport)
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    with pytest.raises(module.UploadSinkError) as exc:
        await sink._open_channel()
    assert exc.value.code == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_sink_hold_merges_every_duplicate_shape():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=FakeSFTP(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(),
    )
    sink._hold(10, b"abcdef")
    sink._hold(10, b"abc")
    sink._hold(10, b"abcdefgh")
    assert sink._pending[10] == b"abcdefgh"

    sink._pending.clear()
    sink._pending_bytes = 0
    sink._hold(10, b"abcdef")
    sink._hold(8, b"xx")
    sink._hold(12, b"zz")
    assert 12 not in sink._pending

    sink._pending.clear()
    sink._pending_bytes = 0
    sink._hold(10, b"abcdef")
    sink._hold(8, b"0000")
    sink._hold(10, b"abcdefgh")
    sink._hold(10, b"ab")
    assert sink._pending[10] == b"abcdefgh"

    sink._pending = {6: b"abcdefghijkl", 18: b"q"}
    sink._pending_bytes = 13
    sink._hold(8, b"xxxxzzzzzzzzzz")
    assert sink._pending[18] == b"zzzz"

    sink._pending = {6: b"abcdefghijkl", 18: b"wxyz"}
    sink._pending_bytes = 16
    sink._hold(8, b"xxxxzzzzzzzzzz")
    assert sink._pending[18] == b"wxyz"


@pytest.mark.asyncio
async def test_sink_drain_drops_fully_consumed_and_shorter_overlaps():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=FakeSFTP(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(),
    )
    sink._streamed = 4
    sink._pending = {0: b"aaaa", 2: b"bb", 4: b"cccccc"}
    sink._pending_bytes = 12
    sent: list[bytes] = []
    sink._send_locked = AsyncMock(side_effect=lambda data: (sent.append(data), setattr(sink, "_streamed", sink._streamed + len(data))))
    sink._pending[4] = b"c"
    await sink._drain_locked()
    assert sent == [b"c"]

    sink._streamed = 10
    sink._pending = {8: b"abcdefghijkl", 10: b"1234567890"}
    sink._pending_bytes = 22
    sent.clear()
    await sink._drain_locked()
    assert sent == [b"1234567890"]

    sink._streamed = 10
    sink._pending = {8: b"abcdefghijkl", 10: b"x"}
    sink._pending_bytes = 13
    sent.clear()
    await sink._drain_locked()
    assert sent == [b"cdefghijkl"]


@pytest.mark.asyncio
async def test_sink_write_at_failure_after_wait_and_overlaps():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=FakeSFTP(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(),
    )
    sink._streamed = 10
    sink._failure = module.UploadSinkError("failed")
    with (
        patch("torrus.sftp_manager.asyncio.wait_for", AsyncMock(return_value=None)),
        pytest.raises(module.UploadSinkError, match="failed"),
    ):
        await sink.write_at(5, b"abc")

    sink._failure = None
    sink._streamed = 5
    sink._pending.clear()
    sink._pending_bytes = 0
    sink._send_locked = AsyncMock()
    sink._drain_locked = AsyncMock()
    await sink.write_at(2, b"abcd")
    sink._send_locked.assert_awaited_once_with(b"d")
    await sink.write_at(5, b"")
    assert sink._send_locked.await_count == 1

    sink._streamed = 0
    sink._pending.clear()
    sink._pending_bytes = module._SINK_PENDING_MAX_BYTES

    async def fail_during_wait(*_args, **_kwargs):
        _args[0].close()
        sink._failure = module.UploadSinkError("became broken")

    with (
        patch("torrus.sftp_manager.asyncio.wait_for", fail_during_wait),
        pytest.raises(module.UploadSinkError, match="became broken"),
    ):
        await sink.write_at(2, b"x")


@pytest.mark.asyncio
async def test_sink_finish_stream_failures_and_status():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=FakeSFTP(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(),
    )
    channel = MagicMock()
    sink._channel = channel
    sink._run = AsyncMock(side_effect=OSError("shutdown failed"))
    with pytest.raises(module.UploadSinkError):
        await sink._finish_stream()

    channel = MagicMock()
    sink._channel = channel
    sink._run = AsyncMock(side_effect=[None, 3, OSError("close"), "detail"])
    with pytest.raises(module.UploadSinkError, match="detail"):
        await sink._finish_stream()

    sink._channel = MagicMock()
    sink._run = AsyncMock(side_effect=[None, 3, OSError("close"), ""])
    with pytest.raises(module.UploadSinkError, match="exit status 3"):
        await sink._finish_stream()


@pytest.mark.asyncio
async def test_sink_stream_failure_without_a_channel_and_new_file_publish():
    client = FakeSFTP()
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    sink._channel = None
    error = await sink._stream_failure(OSError("closed"))
    assert error.code

    client.fs["/home/app/.file.txt.upload-part-upload1"] = b"new"
    await sink._publish()
    assert client.fs["/home/app/file.txt"] == b"new"
    assert "/home/app/.file.txt.upload-part-upload1" not in client.fs


@pytest.mark.asyncio
async def test_sink_publish_without_posix_rename_or_an_existing_destination():
    class NoPosixRename(FakeSFTP):
        def posix_rename(self, *_args):
            raise OSError(errno.EOPNOTSUPP, "unsupported")

    client = NoPosixRename()
    client.fs["/home/app/.file.txt.upload-part-upload1"] = b"new"
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )

    await sink._publish()
    assert client.fs["/home/app/file.txt"] == b"new"


@pytest.mark.asyncio
async def test_sink_publish_fallback_failures():
    class FailingClient(FakeSFTP):
        def posix_rename(self, *_args):
            raise OSError(errno.EOPNOTSUPP, "unsupported")

        def lstat(self, _path):
            raise OSError("missing")

        def rename(self, old_path, new_path):
            if old_path.endswith(".upload-part-upload1"):
                raise OSError("publish failed")
            super().rename(old_path, new_path)

    client = FailingClient()
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    with pytest.raises(module.UploadSinkError):
        await sink._publish()

    class RestoreFailureClient(FailingClient):
        def rename(self, old_path, new_path):
            if "replaced" in old_path:
                raise OSError("restore failed")
            if old_path.endswith(".upload-part-upload1"):
                raise OSError("publish failed")
            super(FailingClient, self).rename(old_path, new_path)

    client = RestoreFailureClient()
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    client.fs["/home/app/file.txt"] = b"old"
    with pytest.raises(module.UploadSinkError):
        await sink._publish()

    class RemoveFailureClient(FakeSFTP):
        def posix_rename(self, *_args):
            raise OSError(errno.EOPNOTSUPP, "unsupported")

        def remove(self, path):
            raise OSError("remove failed")

    client = RemoveFailureClient()
    client.fs["/home/app/file.txt"] = b"old"
    client.fs["/home/app/.file.txt.upload-part-upload1"] = b"new"
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=client,
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
    )
    await sink._publish()


@pytest.mark.asyncio
async def test_sink_close_is_idempotent_and_tolerates_errors():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=MagicMock(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=OSError("close failed")),
    )
    await sink._close_client()
    assert sink._client_closed is True
    sink._client.close.assert_not_called()
    await sink._close_client()


@pytest.mark.asyncio
async def test_sink_abort_tolerates_channel_and_remove_errors():
    sink = SFTPSink(
        manager=MagicMock(),
        tab_id="tab",
        client=MagicMock(),
        directory="/home/app",
        filename="file.txt",
        session_id="upload1",
        run_blocking=AsyncMock(side_effect=OSError("close")),
    )
    sink._channel = MagicMock()
    await sink.abort()
    assert sink._channel is None


@pytest.mark.asyncio
async def test_open_sftp_failures_and_fallbacks():
    manager = SFTPManager()
    ssh = SimpleNamespace(open_sftp_channel=AsyncMock(return_value=None))
    with patch.object(manager, "_close_sftp_unlocked", AsyncMock()):
        assert await manager.open_sftp("sess", "tab", ssh) is False

    sftp = FakeSFTP()
    sftp.chdir = MagicMock(side_effect=OSError("chdir"))
    manager = SFTPManager()
    with patch.object(manager, "_close_sftp_unlocked", AsyncMock()):
        assert await manager.open_sftp("sess", "tab", FakeSSHManager(sftp))
    assert manager._sessions["tab"].cwd == "."

    manager = SFTPManager()
    ssh = SimpleNamespace(
        open_sftp_channel=AsyncMock(return_value=sftp),
        get_session_target=AsyncMock(side_effect=RuntimeError("target")),
    )
    with patch.object(manager, "_close_sftp_unlocked", AsyncMock()):
        assert await manager.open_sftp("sess", "tab", ssh)
    assert manager._sessions["tab"].target is None

    manager = SFTPManager()
    ssh = SimpleNamespace(open_sftp_channel=AsyncMock(return_value=FakeSFTP()))
    with patch.object(manager, "_close_sftp_unlocked", AsyncMock()):
        assert await manager.open_sftp("sess", "tab", ssh)
    assert manager._sessions["tab"].target is None
    await manager.shutdown()


@pytest.mark.asyncio
async def test_open_upload_sink_refuses_a_closed_connection():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    ssh = SimpleNamespace(open_sftp_channel=AsyncMock(return_value=None))
    with pytest.raises(SFTPError) as exc:
        await manager.open_upload_sink("tab", "u", "/", "x", ssh)
    assert exc.value.code == "CONNECTION_CLOSED"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_close_swallows_client_errors_and_forgets_uploads():
    manager = SFTPManager()
    sftp = MagicMock()
    sftp.close.side_effect = OSError("close")
    manager._sessions["tab"] = session_for(sftp)
    manager._upload_clients["tab"] = {sftp}
    await manager.close_sftp("tab")
    assert "tab" not in manager._sessions
    await manager.shutdown()


@pytest.mark.asyncio
async def test_list_directory_preserves_sftp_errors_and_maps_others():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    with patch.object(
        manager, "_list_directory_sync", side_effect=SFTPError("X", "bad")
    ), pytest.raises(SFTPError, match="bad"):
        await manager.list_directory("tab")
    with patch.object(
        manager, "_list_directory_sync", side_effect=OSError("boom")
    ), pytest.raises(SFTPError) as exc:
        await manager.list_directory("tab")
    assert exc.value.code == "TRANSFER_FAILED"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_bulk_prepare_passthrough_and_limit():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    with patch.object(
        manager,
        "_prepare_bulk_download_sync",
        return_value={"ok": False, "error": "no"},
    ):
        assert (await manager.prepare_bulk_download("tab", ["x"]))["ok"] is False
    with patch.object(
        manager,
        "_prepare_bulk_download_sync",
        return_value={"ok": True, "files": [("/a", "a", 2)]},
    ), patch("torrus.sftp_manager.BULK_ZIP_MAX_BYTES", 1), pytest.raises(SFTPError) as exc:
        await manager.prepare_bulk_download("tab", ["a"])
    assert exc.value.code == "ARCHIVE_TOO_LARGE"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_resolve_upload_path_uses_the_open_tab():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    assert manager.resolve_upload_path("tab", "x") == "/home/app/x"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_stream_download_open_and_close_errors():
    manager = SFTPManager()
    sftp = FakeSFTP()
    manager._sessions["tab"] = session_for(sftp)
    sftp.open = MagicMock(side_effect=FileNotFoundError(errno.ENOENT, "missing"))
    with pytest.raises(SFTPError) as exc:
        await manager.stream_download("tab", "missing").__anext__()
    assert exc.value.code == "FILE_NOT_FOUND"

    close_error = OSError("close")
    sftp = FakeSFTP()
    sftp.fs["/home/app/close.txt"] = b"x"
    sftp.next_file_close_error = close_error
    manager._sessions["tab"] = session_for(sftp)
    chunks = [chunk async for chunk in manager.stream_download("tab", "close.txt")]
    assert chunks == [b"x"]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_stream_bulk_zip_maps_errors_after_start():
    manager = SFTPManager()
    sftp = FakeSFTP()
    manager._sessions["tab"] = session_for(sftp)

    def broken(*_args):
        raise OSError("Socket is closed")
        yield b""

    with patch.object(manager, "_bulk_zip_sync", broken), pytest.raises(SFTPError) as exc:
        await manager.stream_bulk_zip("tab", []).__anext__()
    assert exc.value.code == "DOWNLOAD_INTERRUPTED"

    with (
        patch.object(manager, "_bulk_zip_sync", side_effect=SFTPError("X", "bad")),
        pytest.raises(SFTPError, match="bad"),
    ):
        await manager.stream_bulk_zip("tab", []).__anext__()

    with (
        patch.object(manager, "_bulk_zip_sync", side_effect=PermissionError("bad")),
        pytest.raises(SFTPError) as exc,
    ):
        await manager.stream_bulk_zip("tab", []).__anext__()
    assert exc.value.code == "PERMISSION_DENIED"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_locked_maps_generic_errors():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    with pytest.raises(SFTPError) as exc:
        await manager._locked("tab", lambda _session: (_ for _ in ()).throw(OSError("boom")))
    assert exc.value.code == "TRANSFER_FAILED"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_run_blocking_survives_read_failures(monkeypatch):
    manager = SFTPManager()
    monkeypatch.setattr(os, "read", MagicMock(side_effect=OSError("closed")))
    assert await manager._run_blocking(lambda: "ok") == "ok"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_run_blocking_survives_reader_removal_failures(monkeypatch):
    manager = SFTPManager()
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "remove_reader", MagicMock(side_effect=OSError("closed")))
    assert await manager._run_blocking(lambda: "ok") == "ok"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_run_blocking_cancels_cleanly():
    manager = SFTPManager()
    task = asyncio.create_task(manager._run_blocking(lambda: __import__("time").sleep(0.05)))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await manager.shutdown()


@pytest.mark.asyncio
async def test_run_blocking_ignores_a_completion_after_cancellation(monkeypatch):
    manager = SFTPManager()
    loop = asyncio.get_running_loop()
    callbacks = []
    monkeypatch.setattr(loop, "add_reader", lambda _fd, callback: callbacks.append(callback))
    task = asyncio.create_task(manager._run_blocking(lambda: __import__("time").sleep(0.05)))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.to_thread(__import__("time").sleep, 0.1)
    callbacks[0]()
    await manager.shutdown()


@pytest.mark.asyncio
async def test_run_blocking_submit_failure_closes_both_descriptors(monkeypatch):
    manager = SFTPManager()
    manager._executor = MagicMock()
    manager._executor.submit.side_effect = RuntimeError("submit")
    close = MagicMock()
    monkeypatch.setattr(os, "close", close)
    with pytest.raises(RuntimeError, match="submit"):
        await manager._run_blocking(lambda: "ok")
    assert close.call_count == 2


def test_source_lookup_and_staging_reap():
    manager = SFTPManager()
    assert manager.get_source_tab_id("missing") is None
    manager._sessions["tab"] = session_for(source_tab_id="source")
    assert manager.get_source_tab_id("tab") == "source"
    assert manager.get_source_tab_id("tab", "other") is None

    sftp = FakeSFTP()
    session = session_for(sftp)
    stale = SimpleNamespace(
        filename=".x.upload-part-" + "a" * 32,
        st_mtime=0,
        st_mode=stat.S_IFREG,
    )
    sftp.remove = MagicMock(side_effect=OSError("remove"))
    manager._reap_stale_staging(session, "/dir", stale)
    sftp.remove.assert_called_once()
    manager._reap_stale_staging(session, "/dir", SimpleNamespace(filename="x", st_mtime=None, st_mode=stat.S_IFREG))
    manager._reap_stale_staging(session, "/dir", SimpleNamespace(filename="x", st_mtime=0, st_mode=stat.S_IFDIR))


def test_list_directory_maps_symlinks_and_staging():
    manager = SFTPManager()
    sftp = FakeSFTP()
    session = session_for(sftp)
    attrs = [
        SimpleNamespace(
            filename=".staging.upload-part-" + "a" * 32,
            st_mtime=0,
            st_mode=stat.S_IFREG,
            st_size=0,
            st_uid=1,
            st_gid=1,
        ),
        SimpleNamespace(
            filename="link",
            st_mtime=1,
            st_mode=stat.S_IFLNK,
            st_size=1,
            st_uid=1,
            st_gid=1,
        ),
        SimpleNamespace(
            filename="broken",
            st_mtime=1,
            st_mode=stat.S_IFLNK,
            st_size=1,
            st_uid=1,
            st_gid=1,
        ),
    ]
    sftp.listdir_attr = MagicMock(return_value=attrs)

    def fake_stat(path):
        if path.endswith("broken"):
            raise OSError("broken")
        return SimpleNamespace(st_mode=stat.S_IFDIR)

    sftp.stat = fake_stat
    sftp.open = MagicMock(side_effect=FileNotFoundError())
    result = manager._list_directory_sync(session, "/home/app")
    assert [item["type"] for item in result["entries"]] == ["directory", "symlink"]

    sftp.listdir_attr = MagicMock(side_effect=OSError("listing"))
    with pytest.raises(SFTPError):
        manager._list_directory_sync(session, "/home/app")


def test_download_and_prepare_paths_cover_limits_and_errors():
    manager = SFTPManager()
    sftp = FakeSFTP()
    session = session_for(sftp)
    with pytest.raises(SFTPError) as exc:
        manager._download_file_sync(session, "readme.txt", max_bytes=5)
    assert exc.value.code == "TRANSFER_TOO_LARGE"
    assert manager._download_file_sync(session, "readme.txt", max_bytes=100)["ok"] is True
    with pytest.raises(SFTPError) as exc:
        manager._prepare_download_sync(session, "/home/app")
    assert exc.value.code == "TRANSFER_FAILED"
    sftp.stat = MagicMock(side_effect=FileNotFoundError())
    with pytest.raises(SFTPError) as exc:
        manager._prepare_download_sync(session, "missing")
    assert exc.value.code == "FILE_NOT_FOUND"


def test_bulk_download_dedupes_and_walks_symlinks():
    manager = SFTPManager()
    sftp = FakeSFTP()
    sftp.fs["/home/app/dir/a.txt"] = b"a"
    sftp.fs["/home/app/other/a.txt"] = b"b"
    sftp.dirs.update({"/home/app/dir", "/home/app/other"})
    sftp.normalize = MagicMock(side_effect=lambda path: path)
    session = session_for(sftp)
    with pytest.raises(SFTPError) as exc:
        manager._prepare_bulk_download_sync(session, [])
    assert exc.value.code == "INVALID_REQUEST"

    result = manager._prepare_bulk_download_sync(
        session, ["/home/app/dir/a.txt", "/home/app/dir/a.txt", "/home/app/other/a.txt"]
    )
    assert [item[1] for item in result["files"]] == ["a (2).txt", "a.txt"]

    result = manager._prepare_bulk_download_sync(
        session, ["/home/app/dir", "/home/app/dir"]
    )
    assert len(result["files"]) == 1

    sftp.normalize.side_effect = OSError("normalize")
    with pytest.raises(SFTPError):
        manager._prepare_bulk_download_sync(session, ["x"])
    sftp.normalize.side_effect = None
    sftp.normalize.return_value = "/home/app/x"
    sftp.stat = MagicMock(side_effect=FileNotFoundError())
    with pytest.raises(SFTPError):
        manager._prepare_bulk_download_sync(session, ["x"])


def test_iter_dir_files_handles_symlinks_cycles_and_errors():
    manager = SFTPManager()
    sftp = FakeSFTP()
    session = session_for(sftp)
    directory = SimpleNamespace(
        filename="loop",
        st_mode=stat.S_IFLNK,
        st_size=0,
    )
    file_link = SimpleNamespace(filename="file-link", st_mode=stat.S_IFLNK, st_size=0)
    broken = SimpleNamespace(filename="broken", st_mode=stat.S_IFLNK, st_size=0)
    plain = SimpleNamespace(filename="plain", st_mode=0, st_size=7)
    fifo = SimpleNamespace(filename="fifo", st_mode=stat.S_IFIFO, st_size=0)
    sftp.listdir_attr = MagicMock(side_effect=[[directory, file_link, broken, plain, fifo], []])

    def fake_stat(path):
        if path.endswith("broken"):
            raise OSError("broken")
        if path.endswith("loop"):
            return SimpleNamespace(st_mode=stat.S_IFDIR)
        return SimpleNamespace(st_mode=stat.S_IFREG, st_size=3)

    sftp.stat = fake_stat
    assert manager._iter_dir_files_sync(session, "/home/app") == [
        ("/home/app/file-link", 3),
        ("/home/app/plain", 7),
    ]
    sftp.listdir_attr = MagicMock(side_effect=OSError("listing"))
    with pytest.raises(SFTPError):
        manager._iter_dir_files_sync(session, "/home/app")


@pytest.mark.asyncio
async def test_disconnect_callbacks_ignore_nonmatching_sessions():
    manager = SFTPManager()
    manager._sessions["tab"] = session_for()
    with patch.object(manager, "close_sftp", AsyncMock()) as close:
        await manager.on_ssh_disconnect("other")
        await manager.on_ssh_tab_disconnect("sess", "other")
    close.assert_not_awaited()
    await manager.shutdown()



def test_bulk_zip_and_delete_error_paths():
    manager = SFTPManager()
    sftp = FakeSFTP()
    sftp.fs["/home/app/a.txt"] = b"a" * 10
    session = session_for(sftp)
    archive = list(
        manager._bulk_zip_sync(session, [("/home/app/a.txt", "../safe.txt", 10)], 2)
    )
    assert archive
    with pytest.raises(SFTPError):
        list(manager._bulk_zip_sync(session, [("/home/app/missing", "x", 1)], 2))

    sftp.lstat = MagicMock(side_effect=SFTPError("X", "bad"))
    with pytest.raises(SFTPError, match="bad"):
        manager._delete_sync(session, "x")
    sftp.lstat = MagicMock(return_value=SimpleNamespace(st_mode=stat.S_IFDIR))
    sftp.rmdir = MagicMock(side_effect=OSError(errno.ENOTEMPTY, "not empty"))
    sftp.listdir_attr = MagicMock(side_effect=OSError("gone"))
    with pytest.raises(SFTPError) as exc:
        manager._delete_sync(session, "x")
    assert exc.value.code == "DIRECTORY_NOT_EMPTY"

    sftp.rmdir = MagicMock(side_effect=OSError("not empty"))
    sftp.listdir_attr = MagicMock(side_effect=OSError("gone"))
    with pytest.raises(SFTPError) as exc:
        manager._delete_sync(session, "x")
    assert exc.value.code == "TRANSFER_FAILED"


def test_operation_error_mapping_and_account_cache():
    manager = SFTPManager()
    sftp = FakeSFTP()
    session = session_for(sftp)
    sftp.rename = MagicMock(side_effect=OSError("rename"))
    with pytest.raises(SFTPError):
        manager._rename_sync(session, "a", "b")
    sftp.mkdir = MagicMock(side_effect=OSError("mkdir"))
    with pytest.raises(SFTPError):
        manager._mkdir_sync(session, "x")

    session.account_maps_refreshed = 1
    with patch("torrus.sftp_manager.time.time", return_value=2):
        assert manager._account_maps_sync(session) == ({}, {})

    sftp.open = MagicMock(side_effect=[OSError("passwd"), OSError("group")])
    assert manager._account_maps_sync(session, force=True) == ({}, {})


def test_path_resolution_deduplication_and_helpers():
    assert _resolve_remote_path("/home/a", "~", "/home/b") == "/home/b"
    assert _resolve_remote_path("/home/a", "~/x", "/home/b") == "/home/b/x"
    assert _resolve_remote_path("", "", None) == "."
    assert _resolve_remote_path(".", "x", ".") == "x"
    assert _dedupe_arcname("a", set()) == "a"
    assert _dedupe_arcname("a", {"a"}) == "a (2)"
    assert _dedupe_arcname("a.txt", {"a.txt", "a (2).txt"}) == "a (3).txt"
    assert module.safe_arcname("../x") == "x"
    assert module.safe_arcname(".") == "unnamed"

    iterator = iter([])
    sentinel = object()
    assert _next_or_sentinel(iterator, sentinel) is sentinel


def test_remote_text_parsers_and_error_classification():
    sftp = FakeSFTP()
    sftp.fs["/text"] = b"hello"
    class TextFile:
        def __init__(self, data):
            self.data = data

        def read(self, _size):
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    sftp.open = MagicMock(return_value=TextFile("text"))
    assert _read_remote_text(sftp, "/text") == "text"
    sftp.open = MagicMock(return_value=TextFile(b"bytes"))
    assert _read_remote_text(sftp, "/text") == "bytes"

    assert _parse_passwd("# comment\n\nbad\nuser:x:not-an-int:1\n") == {}
    assert _parse_group("# comment\n\nbad\ngroup:x:not-an-int\n") == {}
    assert _map_error(SFTPError("X", "same"), "/x").code == "X"
    assert (
        _map_error(OSError(errno.ENOTEMPTY, "not empty"), "/x").code
        == "DIRECTORY_NOT_EMPTY"
    )
    assert _is_connection_closed(EOFError(), None, "") is True
    assert (
        _is_connection_closed(
            OSError(errno.ECONNRESET, "reset"), errno.ECONNRESET, ""
        )
        is True
    )
    assert _is_connection_closed(OSError("Socket is closed"), None, "Socket is closed")
    assert not _is_connection_closed(ValueError("other"), None, "other")
    assert _sink_error(FileNotFoundError(), "x").status == 404


def test_spooled_zip_writer_is_deliberately_non_seekable(tmp_path):
    writer = _SpooledZipWriter()
    try:
        writer.write(b"abc")
        assert writer.tell() == 3
        writer.flush()
        assert writer.seekable() is False
        assert writer.take(2) == b"ab"
    finally:
        writer.close()
