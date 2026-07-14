"""SFTP session manager built on top of active SSH transports."""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import errno
import os
import posixpath
import stat
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable, AsyncIterator, TypeVar

import paramiko

T = TypeVar("T")


class SFTPError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class SFTPSession:
    session_id: str
    tab_id: str
    client: paramiko.SFTPClient
    cwd: str = "."
    home: str = "."
    users: dict[int, str] = field(default_factory=dict)
    groups: dict[int, str] = field(default_factory=dict)
    last_activity: float = field(default_factory=time.time)


class SFTPManager:
    def __init__(self):
        self._sessions: dict[str, SFTPSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=10, thread_name_prefix="sftp"
        )

    async def shutdown(self) -> None:
        for tab_id in list(self._sessions):
            await self.close_sftp(tab_id)
        self._executor.shutdown(wait=False, cancel_futures=True)

    async def open_sftp(
        self,
        session_id: str,
        tab_id: str,
        ssh_manager,
        source_tab_id: str | None = None,
    ) -> bool:
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            await self._close_sftp_unlocked(tab_id)
            client = await ssh_manager.open_sftp_channel(session_id, source_tab_id or tab_id)
            if client is None:
                return False

            sftp_session = SFTPSession(session_id=session_id, tab_id=tab_id, client=client)
            try:
                sftp_session.cwd = await self._run_blocking(_initial_cwd, client)
                sftp_session.home = sftp_session.cwd
            except Exception:
                sftp_session.cwd = "."
                sftp_session.home = "."

            self._sessions[tab_id] = sftp_session
            return True

    async def close_sftp(self, tab_id: str) -> None:
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            await self._close_sftp_unlocked(tab_id)

    async def _close_sftp_unlocked(self, tab_id: str) -> None:
        session = self._sessions.pop(tab_id, None)
        if session is None:
            return
        try:
            await self._run_blocking(session.client.close)
        except Exception:
            pass

    async def on_ssh_disconnect(self, session_id: str) -> None:
        for tab_id, session in list(self._sessions.items()):
            if session.session_id == session_id:
                await self.close_sftp(tab_id)

    async def list_directory(self, tab_id: str, path: str = ".") -> dict[str, Any]:
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            session = self._get_session(tab_id)
            session.last_activity = time.time()
            try:
                result = await self._run_blocking(self._list_directory_sync, session, path)
                session.cwd = result["path"]
                return result
            except SFTPError:
                raise
            except Exception as exc:
                raise _map_error(exc, getattr(exc, "filename", "")) from exc

    async def upload_file(self, tab_id: str, remote_path: str, data: bytes) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._upload_file_sync(session, remote_path, data))

    async def download_file(self, tab_id: str, remote_path: str) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._download_file_sync(session, remote_path))

    async def prepare_download(
        self,
        tab_id: str,
        remote_path: str,
        expected_session_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._locked(
            tab_id,
            lambda session: self._prepare_download_sync(session, remote_path),
            expected_session_id=expected_session_id,
        )

    async def delete(self, tab_id: str, path: str) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._delete_sync(session, path))

    async def rename(self, tab_id: str, old_path: str, new_path: str) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._rename_sync(session, old_path, new_path))

    async def mkdir(self, tab_id: str, path: str) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._mkdir_sync(session, path))

    async def chmod(self, tab_id: str, path: str, mode: int) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._chmod_sync(session, path, mode))

    async def chown(self, tab_id: str, path: str, uid: int, gid: int) -> dict[str, Any]:
        return await self._locked(tab_id, lambda session: self._chown_sync(session, path, uid, gid))

    async def accounts(self, tab_id: str) -> dict[str, Any]:
        return await self._locked(tab_id, self._accounts_sync)

    async def stream_upload(
        self,
        tab_id: str,
        remote_path: str,
        chunks,
        max_bytes: int,
        expected_session_id: str | None = None,
    ) -> dict[str, Any]:
        async def write_stream(session: SFTPSession) -> dict[str, Any]:
            resolved = _resolve_remote_path(session.cwd, remote_path, session.home)
            wrote = 0
            remove_partial = False
            try:
                remote_file = await self._run_blocking(session.client.open, resolved, "wb")
                try:
                    async for chunk in chunks:
                        wrote += len(chunk)
                        if wrote > max_bytes:
                            remove_partial = True
                            raise SFTPError("FILE_TOO_LARGE", f"File too large for browser transfer ({wrote} bytes).")
                        await self._run_blocking(remote_file.write, chunk)
                finally:
                    pending_error = sys.exc_info()[1]
                    try:
                        await self._run_blocking(remote_file.close)
                    except Exception:
                        if pending_error is None:
                            raise
                    if remove_partial:
                        await self._remove_partial_upload(session, resolved)
            except Exception as exc:
                raise _map_error(exc, resolved) from exc
            return {"ok": True, "path": resolved, "size": wrote}

        return await self._locked_stream(tab_id, write_stream, expected_session_id=expected_session_id)

    async def stream_download(
        self,
        tab_id: str,
        remote_path: str,
        chunk_size: int = 64 * 1024,
        expected_session_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            session = self._get_session(tab_id, expected_session_id=expected_session_id)
            session.last_activity = time.time()
            resolved = _resolve_remote_path(session.cwd, remote_path, session.home)
            try:
                remote_file = await self._run_blocking(session.client.open, resolved, "rb")
            except Exception as exc:
                raise _map_error(exc, resolved) from exc

        try:
            while True:
                chunk = await self._run_blocking(remote_file.read, chunk_size)
                if not chunk:
                    break
                session.last_activity = time.time()
                yield chunk
        except Exception as exc:
            mapped = _map_error(exc, resolved)
            if mapped.code in {"CONNECTION_CLOSED", "TRANSFER_FAILED"}:
                raise SFTPError("DOWNLOAD_INTERRUPTED", "Download interrupted. Reconnect and try again.") from exc
            raise mapped from exc
        finally:
            async with lock:
                session.last_activity = time.time()
                try:
                    await self._run_blocking(remote_file.close)
                except Exception:
                    pass

    async def _locked(self, tab_id: str, work, expected_session_id: str | None = None):
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            session = self._get_session(tab_id, expected_session_id=expected_session_id)
            session.last_activity = time.time()
            try:
                return await self._run_blocking(work, session)
            except SFTPError:
                raise
            except Exception as exc:
                raise _map_error(exc, getattr(exc, "filename", "")) from exc

    async def _locked_stream(self, tab_id: str, work, expected_session_id: str | None = None):
        lock = self._locks.setdefault(tab_id, asyncio.Lock())
        async with lock:
            session = self._get_session(tab_id, expected_session_id=expected_session_id)
            session.last_activity = time.time()
            try:
                return await work(session)
            except SFTPError:
                raise
            except Exception as exc:
                raise _map_error(exc, getattr(exc, "filename", "")) from exc

    async def _run_blocking(self, fn: Callable[..., T], *args: Any) -> T:
        loop = asyncio.get_running_loop()
        read_fd, write_fd = os.pipe()
        result_future: asyncio.Future[T] = loop.create_future()
        result: dict[str, Any] = {}

        def work() -> None:
            try:
                result["value"] = fn(*args)
            except BaseException as exc:
                result["error"] = exc
            finally:
                try:
                    os.write(write_fd, b"x")
                except OSError:
                    pass

        def complete() -> None:
            try:
                os.read(read_fd, 1)
            except OSError:
                pass
            if "error" in result:
                result_future.set_exception(result["error"])
            else:
                result_future.set_result(result["value"])

        worker_future = None
        try:
            worker_future = self._executor.submit(work)
            loop.add_reader(read_fd, complete)
            return await result_future
        except asyncio.CancelledError:
            if worker_future is not None:
                worker_future.cancel()
            raise
        finally:
            try:
                loop.remove_reader(read_fd)
            except Exception:
                pass
            os.close(read_fd)
            os.close(write_fd)

    async def _remove_partial_upload(self, session: SFTPSession, path: str) -> None:
        try:
            await self._run_blocking(session.client.remove, path)
        except Exception:
            pass

    def _get_session(self, tab_id: str, expected_session_id: str | None = None) -> SFTPSession:
        session = self._sessions.get(tab_id)
        if session is None:
            raise SFTPError("CONNECTION_CLOSED", "SSH connection lost. Reconnect to continue.")
        if expected_session_id is not None and session.session_id != expected_session_id:
            raise SFTPError("PERMISSION_DENIED", "SFTP tab is not available for this session.")
        return session

    def _list_directory_sync(self, session: SFTPSession, path: str) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, path, session.home)
        try:
            users, groups = self._account_maps_sync(session)
            entries = []
            for attr in session.client.listdir_attr(resolved):
                mode = attr.st_mode or 0
                is_dir = stat.S_ISDIR(mode)
                is_link = stat.S_ISLNK(mode)
                entry_path = posixpath.join(resolved, attr.filename)
                if is_link:
                    try:
                        is_dir = stat.S_ISDIR((session.client.stat(entry_path).st_mode or 0))
                    except Exception:
                        pass
                entries.append(
                    {
                        "name": attr.filename,
                        "path": entry_path,
                        "type": "directory" if is_dir else "symlink" if is_link else "file",
                        "is_symlink": is_link,
                        "size": attr.st_size or 0,
                        "mtime": attr.st_mtime or 0,
                        "mode": mode,
                        "uid": attr.st_uid,
                        "gid": attr.st_gid,
                        "owner": users.get(attr.st_uid),
                        "group": groups.get(attr.st_gid),
                    }
                )
            entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
            return {"ok": True, "path": resolved, "entries": entries}
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _upload_file_sync(self, session: SFTPSession, remote_path: str, data: bytes) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, remote_path, session.home)
        try:
            with session.client.open(resolved, "wb") as remote_file:
                remote_file.write(data)
            return {"ok": True, "path": resolved, "size": len(data)}
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _download_file_sync(self, session: SFTPSession, remote_path: str) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, remote_path, session.home)
        try:
            with session.client.open(resolved, "rb") as remote_file:
                data = remote_file.read()
            return {
                "ok": True,
                "path": resolved,
                "name": posixpath.basename(resolved),
                "data": base64.b64encode(data).decode("ascii"),
            }
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _prepare_download_sync(self, session: SFTPSession, remote_path: str) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, remote_path, session.home)
        try:
            attr = session.client.stat(resolved)
            if stat.S_ISDIR((attr.st_mode or 0)):
                raise SFTPError("TRANSFER_FAILED", f"Cannot download directory: {resolved}")
            return {
                "ok": True,
                "path": resolved,
                "name": posixpath.basename(resolved) or "download",
                "size": attr.st_size or 0,
            }
        except SFTPError:
            raise
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _delete_sync(self, session: SFTPSession, path: str) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, path, session.home)
        try:
            attr = session.client.lstat(resolved)
            if stat.S_ISDIR(attr.st_mode or 0):
                session.client.rmdir(resolved)
            else:
                session.client.remove(resolved)
            return {"ok": True, "path": resolved}
        except SFTPError:
            raise
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _rename_sync(self, session: SFTPSession, old_path: str, new_path: str) -> dict[str, Any]:
        old_resolved = _resolve_remote_path(session.cwd, old_path, session.home)
        new_resolved = _resolve_remote_path(session.cwd, new_path, session.home)
        try:
            session.client.rename(old_resolved, new_resolved)
            return {"ok": True, "old_path": old_resolved, "new_path": new_resolved}
        except Exception as exc:
            raise _map_error(exc, old_resolved) from exc

    def _chmod_sync(self, session: SFTPSession, path: str, mode: int) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, path, session.home)
        try:
            session.client.chmod(resolved, mode)
            return {"ok": True, "path": resolved, "mode": mode}
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _chown_sync(self, session: SFTPSession, path: str, uid: int, gid: int) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, path, session.home)
        try:
            session.client.chown(resolved, uid, gid)
            return {"ok": True, "path": resolved, "uid": uid, "gid": gid}
        except Exception as exc:
            raise _map_error(exc, resolved) from exc

    def _accounts_sync(self, session: SFTPSession) -> dict[str, Any]:
        users, groups = self._account_maps_sync(session, force=True)
        return {
            "ok": True,
            "users": [{"uid": uid, "name": name} for uid, name in sorted(users.items(), key=lambda item: (item[1], item[0]))],
            "groups": [{"gid": gid, "name": name} for gid, name in sorted(groups.items(), key=lambda item: (item[1], item[0]))],
        }

    def _account_maps_sync(self, session: SFTPSession, force: bool = False) -> tuple[dict[int, str], dict[int, str]]:
        if (session.users or session.groups) and not force:
            return session.users, session.groups
        try:
            session.users = _parse_passwd(_read_remote_text(session.client, "/etc/passwd"))
        except Exception:
            session.users = {}
        try:
            session.groups = _parse_group(_read_remote_text(session.client, "/etc/group"))
        except Exception:
            session.groups = {}
        return session.users, session.groups

    def _mkdir_sync(self, session: SFTPSession, path: str) -> dict[str, Any]:
        resolved = _resolve_remote_path(session.cwd, path, session.home)
        try:
            session.client.mkdir(resolved)
            return {"ok": True, "path": resolved}
        except Exception as exc:
            raise _map_error(exc, resolved) from exc


def _resolve_remote_path(cwd: str, path: str, home: str | None = None) -> str:
    raw = (path or ".").strip() or "."
    home_dir = home or (cwd if cwd and cwd != "." else ".")
    if raw == "~":
        return posixpath.normpath(home_dir)
    if raw.startswith("~/"):
        return posixpath.normpath(posixpath.join(home_dir, raw[2:]))
    if raw.startswith("/"):
        return posixpath.normpath(raw)
    base = cwd if cwd and cwd != "." else "."
    return posixpath.normpath(posixpath.join(base, raw))


def _read_remote_text(client: paramiko.SFTPClient, path: str, max_bytes: int = 512 * 1024) -> str:
    with client.open(path, "r") as remote_file:
        data = remote_file.read(max_bytes + 1)
    if isinstance(data, str):
        return data[:max_bytes]
    return bytes(data[:max_bytes]).decode("utf-8", errors="replace")


def _parse_passwd(text: str) -> dict[int, str]:
    users: dict[int, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        try:
            users[int(parts[2])] = parts[0]
        except ValueError:
            continue
    return users


def _parse_group(text: str) -> dict[int, str]:
    groups: dict[int, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        try:
            groups[int(parts[2])] = parts[0]
        except ValueError:
            continue
    return groups


def _initial_cwd(client: paramiko.SFTPClient) -> str:
    client.chdir(".")
    cwd = getattr(client, "cwd", None)
    return cwd or client.getcwd() or "."


def _map_error(exc: Exception, path: str) -> SFTPError:
    if isinstance(exc, SFTPError):
        return exc
    err_no = getattr(exc, "errno", None)
    message = str(exc) or "Transfer failed. Check connection and retry."
    if isinstance(exc, FileNotFoundError) or err_no == errno.ENOENT:
        return SFTPError("FILE_NOT_FOUND", f"File not found: {path}")
    if isinstance(exc, PermissionError) or err_no in {errno.EACCES, errno.EPERM}:
        return SFTPError("PERMISSION_DENIED", f"Permission denied: {path}")
    if _is_connection_closed(exc, err_no, message):
        return SFTPError("CONNECTION_CLOSED", "SSH connection lost. Reconnect to continue.")
    return SFTPError("TRANSFER_FAILED", message)


def _is_connection_closed(exc: Exception, err_no: int | None, message: str) -> bool:
    if isinstance(exc, EOFError):
        return True
    if isinstance(exc, OSError) and err_no in {
        errno.EBADF,
        errno.ECONNABORTED,
        errno.ECONNRESET,
        errno.ENOTCONN,
        errno.EPIPE,
    }:
        return True
    lowered = message.lower()
    return (
        isinstance(exc, (OSError, paramiko.SSHException))
        and (("socket" in lowered and "closed" in lowered) or "connection reset" in lowered)
    )
