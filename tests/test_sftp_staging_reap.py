"""Abandoned upload staging files are reaped when their directory is listed."""

import stat
import time
from types import SimpleNamespace

import paramiko

from torrus import sftp_manager
from torrus.sftp_manager import SFTPManager

SESSION_ID = "0123456789abcdef0123456789abcdef"
STALE = sftp_manager._STALE_STAGING_SECONDS


def _attr(name: str, age: float, mode: int = stat.S_IFREG | 0o644):
    attr = paramiko.SFTPAttributes()
    attr.filename = name
    attr.st_mode = mode
    attr.st_size = 10
    attr.st_mtime = time.time() - age
    attr.st_uid = attr.st_gid = 1000
    return attr


class FakeClient:
    def __init__(self, attrs):
        self._attrs = attrs
        self.removed: list[str] = []

    def listdir_attr(self, _path):
        return self._attrs

    def remove(self, path):
        self.removed.append(path)


def _list(attrs):
    manager = SFTPManager(max_workers=1)
    manager._account_maps_sync = lambda _session: ({}, {})
    client = FakeClient(attrs)
    session = SimpleNamespace(cwd="/data", home="/data", client=client)
    result = manager._list_directory_sync(session, "/data")
    manager._executor.shutdown(wait=False)
    return result, client


def test_stale_staging_file_is_removed_and_never_listed():
    stale = f".big.bin.upload-part-{SESSION_ID}"
    result, client = _list([_attr(stale, STALE + 60), _attr("keep.txt", STALE + 60)])

    assert client.removed == [f"/data/{stale}"]
    assert [entry["name"] for entry in result["entries"]] == ["keep.txt"]


def test_recent_staging_file_belongs_to_a_live_upload_and_is_kept():
    live = f".big.bin.upload-part-{SESSION_ID}"
    result, client = _list([_attr(live, 60)])

    assert client.removed == []
    assert result["entries"] == []


def test_only_files_shaped_like_engine_staging_are_removed():
    lookalike = ".notes.upload-part-backup"
    directory = f".d.upload-part-{SESSION_ID}"
    _, client = _list(
        [
            _attr(lookalike, STALE + 60),
            _attr(directory, STALE + 60, mode=stat.S_IFDIR | 0o755),
        ]
    )

    assert client.removed == []
