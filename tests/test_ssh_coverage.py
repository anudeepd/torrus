"""Coverage for SSH manager branches that are awkward in flow-oriented tests."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from torrus import ssh_manager as module
from torrus.ssh_manager import (
    HostKeyPolicy,
    SSHManager,
    SSHSession,
    _blocking_read,
    _blocking_send_all,
    _check_tmux_blocking,
    _close_ssh_resources,
    _connect_and_check_tmux,
    _connection_probes_blocking,
    _open_tmux_channel,
    _sanitize_replay_buffer,
    _send_keepalive,
)


def session_for(
    *,
    closed: bool = False,
    owner: str | None = "alice",
    client=None,
    channel=None,
) -> SSHSession:
    return SSHSession(
        session_id="sess",
        tab_id="tab",
        client=client or MagicMock(),
        channel=channel or MagicMock(closed=closed),
        host="example.com",
        port=22,
        username="alice",
        owner_ldap_username=owner,
    )


@pytest.mark.asyncio
async def test_connect_rejects_owner_mismatch_and_pending_key(mock_sio):
    manager = SSHManager(mock_sio)
    manager._sessions[("sess", "tab")] = session_for(owner="alice")
    await manager.connect(
        "sid", "sess", "tab", "host", 22, "user", "pass", owner_ldap_username="bob"
    )
    assert mock_sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"

    manager._sessions.clear()
    manager._pending_keys.add(("sess", "tab"))
    await manager.connect("sid", "sess", "tab", "host", 22, "user", "pass")
    assert mock_sio.emit.await_args.args[1]["code"] == "connect_in_progress"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_connect_maps_each_transport_failure(mock_sio):
    import paramiko

    manager = SSHManager(mock_sio)
    cases = [
        (OSError("offline"), "host_unreachable"),
        (paramiko.SSHException("ssh failed"), "ssh_error"),
        (TimeoutError(), "timeout"),
    ]
    for error, code in cases:
        with patch("torrus.ssh_manager.paramiko.SSHClient") as client_class:
            client = client_class.return_value
            client.connect.side_effect = error
            await manager.connect("sid", "sess", "tab", "host", 22, "user", "pass")
        assert mock_sio.emit.await_args.args[1]["code"] == code
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_bad_host_key_is_reported_with_both_fingerprints(mock_sio):
    import paramiko

    manager = SSHManager(mock_sio)
    expected = MagicMock(fingerprint="SHA256:old")
    actual = MagicMock(fingerprint="SHA256:new")
    error = paramiko.BadHostKeyException("example.com", expected, actual)
    with (
        patch("torrus.ssh_manager.paramiko.SSHClient"),
        patch("torrus.ssh_manager._connect_and_check_tmux", side_effect=error),
    ):
        await manager.connect("sid", "sess", "tab", "example.com", 22, "u", "p")
    payload = mock_sio.emit.await_args.args[1]
    assert payload["code"] == "host_key_mismatch"
    assert "SHA256:old" in payload["message"]
    assert "SHA256:new" in payload["message"]
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_shell_open_failure_and_successful_tmux_path(mock_sio):
    manager = SSHManager(mock_sio)
    with (
        patch("torrus.ssh_manager.paramiko.SSHClient") as client_class,
        patch("torrus.ssh_manager._connect_and_check_tmux", return_value=(False, False)),
    ):
        client = client_class.return_value
        client.invoke_shell.side_effect = RuntimeError("no shell")
        await manager.connect("sid", "sess", "tab", "host", 22, "u", "p")
    assert mock_sio.emit.await_args.args[1]["code"] == "shell_error"

    opened = MagicMock(closed=False)
    with (
        patch("torrus.ssh_manager.paramiko.SSHClient") as client_class,
        patch("torrus.ssh_manager._connect_and_check_tmux", return_value=(True, False)),
        patch("torrus.ssh_manager._open_tmux_channel", return_value=opened),
    ):
        await manager.connect("sid", "sess2", "tab2", "host", 22, "u", "p")
    assert manager._sessions[("sess2", "tab2")].channel is opened
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_failed_connect_ignores_a_close_failure(mock_sio):
    manager = SSHManager(mock_sio)
    with patch("torrus.ssh_manager.paramiko.SSHClient") as client_class:
        client = client_class.return_value
        client.connect.side_effect = OSError()
        client.close.side_effect = OSError()
        await manager.connect("sid", "sess", "tab", "host", 22, "u", "p")
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_reconnect_closes_and_notifies_the_previous_session(mock_sio):
    callback = AsyncMock()
    manager = SSHManager(mock_sio, on_tab_disconnect=callback)
    old = session_for()
    manager._sessions[(old.session_id, old.tab_id)] = old
    channel = MagicMock(closed=False)
    with (
        patch("torrus.ssh_manager.paramiko.SSHClient") as client_class,
        patch("torrus.ssh_manager._connect_and_check_tmux", return_value=(False, False)),
    ):
        client_class.return_value.invoke_shell.return_value = channel
        await manager.connect(
            "sid", "sess", "tab", "host", 22, "u", "p", owner_ldap_username="alice"
        )
    callback.assert_awaited_once_with("sess", "tab")
    assert manager._sessions[("sess", "tab")].channel is channel
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_restore_dead_and_owner_fallbacks(mock_sio):
    manager = SSHManager(mock_sio)
    assert await manager.restore_session("sid", "none", "tab") == "dead"

    session = session_for(closed=True)
    manager._sessions[("sess", "tab")] = session
    assert await manager.restore_session("sid", "sess", "tab") == "dead"

    session.channel.closed = False
    manager.set_sid_owner("sid", "bob")
    assert await manager.restore_session("sid", "sess", "tab") == "forbidden"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_force_redraw_guards_and_failure_logging(mock_sio):
    manager = SSHManager(mock_sio)
    await manager.force_redraw("missing", "tab")

    session = session_for(owner="alice")
    manager._sessions[("sess", "tab")] = session
    await manager.force_redraw("sess", "tab", owner_ldap_username="bob")

    session.channel.closed = True
    await manager.force_redraw("sess", "tab")
    session.channel.closed = False
    session.channel.resize_pty.side_effect = RuntimeError("resize failed")
    await manager.force_redraw("sess", "tab")
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_input_guards_empty_submission_and_wait_timeout(mock_sio):
    manager = SSHManager(mock_sio)
    assert await manager.handle_input("none", "tab", "x") == "unknown"

    session = session_for()
    manager._sessions[("sess", "tab")] = session
    assert await manager.handle_input("sess", "tab", "", "bob") == "forbidden"
    assert await manager.handle_input("sess", "tab", "") == "sent"
    assert await manager.handle_input("sess", "tab", b"") == "sent"

    session.input_queue.put_nowait = MagicMock(
        side_effect=asyncio.QueueFull()
    )

    async def fake_wait(tasks, **_kwargs):
        return {tasks[1]}, set()

    with patch("torrus.ssh_manager.asyncio.wait", fake_wait):
        assert await manager.handle_input("sess", "tab", "x") == "unknown"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_input_closes_after_it_has_been_queued(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session
    session.input_queue.put_nowait = MagicMock(
        side_effect=[None, asyncio.QueueFull()]
    )
    session.input_closed.set()
    assert await manager.handle_input("sess", "tab", b"x") == "unknown"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_input_detects_close_entering_the_submit_lock(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session

    class ClosingSubmitLock:
        async def __aenter__(self):
            session.channel.closed = True

        async def __aexit__(self, *_args):
            return False

    session.input_submit_lock = ClosingSubmitLock()
    assert await manager.handle_input("sess", "tab", "x") == "unknown"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_input_calls_the_accepted_callback(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session
    accepted = AsyncMock()

    assert await manager.handle_input(
        "sess", "tab", "hello", on_input_accepted=accepted
    ) == "queued"
    accepted.assert_awaited_once_with(b"hello")
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_interrupt_guards_queue_full_and_timeout(mock_sio):
    manager = SSHManager(mock_sio)
    assert await manager.interrupt("none", "tab") == "unknown"

    session = session_for()
    manager._sessions[("sess", "tab")] = session
    assert await manager.interrupt("sess", "tab", "bob") == "forbidden"

    session.control_queue.put_nowait = MagicMock(side_effect=asyncio.QueueFull())
    assert await manager.interrupt("sess", "tab") == "unknown"

    session.control_queue.put_nowait = MagicMock()
    with patch(
        "torrus.ssh_manager.asyncio.wait_for",
        new=AsyncMock(side_effect=asyncio.TimeoutError()),
    ):
        assert await manager.interrupt("sess", "tab") == "queued"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_session_identity_and_owner_queries(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for(owner=None)
    session.is_root = True
    manager._sessions[("sess", "tab")] = session

    assert await manager.get_session_target("none", "tab") is None
    assert await manager.get_session_target("sess", "tab", "bob") is None
    assert await manager.get_session_identity("none", "tab") is None
    assert await manager.get_session_identity("sess", "tab", "bob") is None
    identity = await manager.get_session_identity("sess", "tab")
    assert identity["owner_ldap_username"] == ""
    assert await manager.is_root_session("none", "tab") is False
    assert await manager.is_root_session("sess", "tab", "bob") is False
    assert await manager.is_root_session("sess", "tab") is True
    assert await manager.has_session("sess", "alice") is False
    assert await manager.has_session("sess") is True
    assert (await manager.list_sessions())[0]["tab_id"] == "tab"
    assert manager.session_count() == 1

    manager._sessions[("sess", "dead")] = session_for(closed=True)
    assert len(await manager.list_sessions()) == 1
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_instance_interrupt_and_termination(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session

    assert await manager.interrupt_session("missing", 1) == "unknown"
    assert await manager.terminate_session("missing", 1) == "unknown"
    assert (
        await manager.interrupt_session(session.session_instance_id, session.generation)
        == "queued"
    )
    assert (
        await manager.terminate_session(session.session_instance_id, session.generation)
        == "closed"
    )

    replacement = session_for()
    manager._sessions[("sess", "tab")] = replacement
    replacement.channel.closed = True
    assert (
        await manager.terminate_session(
            replacement.session_instance_id, replacement.generation
        )
        == "unknown"
    )
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_terminate_owner_sessions_counts_only_closed(mock_sio):
    manager = SSHManager(mock_sio)
    alice = session_for(owner="ALICE")
    bob = session_for(owner="bob")
    bob.tab_id = "other"
    none = session_for(owner=None)
    none.tab_id = "none"
    manager._sessions[(alice.session_id, alice.tab_id)] = alice
    manager._sessions[(bob.session_id, bob.tab_id)] = bob
    manager._sessions[(none.session_id, none.tab_id)] = none
    assert await manager.terminate_owner_sessions("alice") == 1
    assert (bob.session_id, bob.tab_id) in manager._sessions
    assert ("sess", "none") in manager._sessions
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_terminate_owner_sessions_counts_non_closed_results(mock_sio):
    manager = SSHManager(mock_sio)
    alice = session_for(owner="ALICE")
    manager._sessions[(alice.session_id, alice.tab_id)] = alice
    manager.terminate_session = AsyncMock(return_value="unknown")

    assert await manager.terminate_owner_sessions("alice") == 0
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_sftp_channel_guards_and_fallbacks(mock_sio):
    manager = SSHManager(mock_sio)
    assert await manager.open_sftp_channel("none", "tab") is None

    session = session_for()
    manager._sessions[("sess", "tab")] = session
    assert await manager.open_sftp_channel("sess", "tab", "bob") is None

    session.client.get_transport.return_value = None
    assert await manager.open_sftp_channel("sess", "tab") is None
    transport = MagicMock()
    transport.is_active.return_value = False
    session.client.get_transport.return_value = transport
    assert await manager.open_sftp_channel("sess", "tab") is None

    transport.is_active.return_value = True
    sftp = object()
    transport.open_sftp_client.return_value = sftp
    assert await manager.open_sftp_channel("sess", "tab") is sftp

    transport.open_sftp_client.side_effect = AttributeError()
    session.client.open_sftp.return_value = sftp
    assert await manager.open_sftp_channel("sess", "tab") is sftp

    transport.open_sftp_client.side_effect = RuntimeError("sftp failed")
    assert await manager.open_sftp_channel("sess", "tab") is None
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_resize_and_disconnect_guards(mock_sio):
    manager = SSHManager(mock_sio)
    await manager.handle_resize("none", "tab", 80, 24)

    session = session_for()
    manager._sessions[("sess", "tab")] = session
    await manager.handle_resize("sess", "tab", 80, 24, "bob")
    session.channel.closed = True
    await manager.handle_resize("sess", "tab", 80, 24)
    session.channel.closed = False
    session.channel.resize_pty.side_effect = RuntimeError("resize")
    await manager.handle_resize("sess", "tab", 90, 30)
    assert (session.cols, session.rows) == (90, 30)

    assert await manager.disconnect_session("sess", "tab", "bob") == "forbidden"
    assert await manager.disconnect_session("none", "tab") == "unknown"
    assert await manager.disconnect_session("sess", "tab") == "closed"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_clone_guards_replacement_and_shell_failure(mock_sio):
    manager = SSHManager(mock_sio)
    source = session_for()
    manager._sessions[("sess", "source")] = source
    manager._sessions[("sess", "target")] = session_for(owner="bob")
    await manager.clone(
        "sid", "sess", "source", "target", owner_ldap_username="alice"
    )
    assert mock_sio.emit.await_args.args[1]["code"] == "session_owner_mismatch"

    manager._sessions[("sess", "target")] = session_for(owner="alice")
    source.client.invoke_shell.side_effect = RuntimeError("clone failed")
    await manager.clone("sid", "sess", "source", "target", owner_ldap_username="alice")
    assert mock_sio.emit.await_args.args[1]["code"] == "clone_failed"

    source.client.invoke_shell.side_effect = None
    source.client.invoke_shell.return_value = MagicMock(closed=False)
    manager._sessions[("sess", "target")] = session_for(owner="alice")
    await manager.clone("sid", "sess", "source", "target", owner_ldap_username="alice")
    assert manager._sessions[("sess", "target")].generation > 1
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_unmap_ignores_leave_failures(mock_sio):
    manager = SSHManager(mock_sio)
    manager._sessions[("sess", "tab")] = session_for()
    manager._sid_map["sid"] = {("sess", "tab")}
    mock_sio.leave_room.side_effect = RuntimeError("gone")
    await manager.unmap_sid("sid")
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_unmap_ignores_keys_without_a_live_session(mock_sio):
    manager = SSHManager(mock_sio)
    manager._sid_map["sid"] = {("missing", "tab")}

    await manager.unmap_sid("sid")
    assert manager._sid_map == {}
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_read_loop_reports_errors_callback_failures_and_truncation(mock_sio):
    manager = SSHManager(mock_sio, on_output=AsyncMock(side_effect=RuntimeError()))
    session = session_for()
    session.output_buffer.extend(b"x" * (module.OUTPUT_BUFFER_MAX + 1))
    chunks = [b"ok" * 10, RuntimeError("read failed")]

    def recv(_size):
        value = chunks.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    session.channel.recv.side_effect = recv
    await manager._read_loop(session)
    closed = [
        call.args[1]
        for call in mock_sio.emit.await_args_list
        if call.args[0] == "ssh:closed"
    ]
    assert closed[-1]["reason"] == "Connection closed."
    assert len(session.output_buffer) <= module.OUTPUT_BUFFER_MAX
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_read_loop_skips_empty_reads_before_closing(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session
    session.channel.recv.side_effect = [TimeoutError(), RuntimeError("closed")]
    session.channel.exit_status_ready.return_value = False

    await manager._read_loop(session)
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_read_loop_tolerates_a_missing_removed_session(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    manager._sessions[("sess", "tab")] = session
    session.channel.recv.side_effect = RuntimeError("closed")

    with patch.object(manager, "_pop_session_locked", return_value=None):
        await manager._read_loop(session)
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_read_loop_returns_when_the_session_was_replaced(mock_sio):
    manager = SSHManager(mock_sio)
    old = session_for()
    new = session_for()
    manager._sessions[("sess", "tab")] = new
    old.channel.recv.side_effect = RuntimeError("closed")
    await manager._read_loop(old)
    assert manager._sessions[("sess", "tab")] is new
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_read_loop_calls_the_session_disconnect_callback(mock_sio):
    disconnected = AsyncMock()
    manager = SSHManager(mock_sio, on_disconnect=disconnected)
    session = session_for()
    manager._sessions[("sess", "tab")] = session
    session.channel.recv.side_effect = RuntimeError("closed")
    await manager._read_loop(session)
    disconnected.assert_awaited_once_with("sess")
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_write_loop_handles_control_input_and_send_errors(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    request = module._ControlRequest(
        b"\x03", asyncio.get_running_loop().create_future()
    )
    session.control_queue.put_nowait(request)

    def send_and_close(data):
        session.channel.closed = True
        return len(data)

    session.channel.send.side_effect = send_and_close
    session.read_task = asyncio.create_task(asyncio.sleep(10))
    await manager._write_loop(session)
    assert request.completion.result() == "sent"

    session = session_for()
    session.input_queue.put_nowait(b"x")
    session.channel.send.side_effect = RuntimeError("write failed")
    session.read_task = asyncio.create_task(asyncio.sleep(10))
    await manager._write_loop(session)
    await asyncio.sleep(0)
    assert session.read_task.cancelled() or session.read_task.done()
    await asyncio.gather(*manager._tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_write_loop_cancellation_completes_a_control_request(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    request = module._ControlRequest(
        b"\x03", asyncio.get_running_loop().create_future()
    )
    session.control_queue.put_nowait(request)
    session.channel.send.side_effect = asyncio.CancelledError()
    task = asyncio.create_task(manager._write_loop(session))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert request.completion.result() == "failed"


@pytest.mark.asyncio
async def test_write_loop_drains_multiple_control_requests(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    first = module._ControlRequest(b"\x03", asyncio.get_running_loop().create_future())
    second = module._ControlRequest(b"\x04", asyncio.get_running_loop().create_future())
    session.control_queue.put_nowait(first)
    session.control_queue.put_nowait(second)
    sends = 0

    def send_and_close(data):
        nonlocal sends
        sends += 1
        if sends == 2:
            session.channel.closed = True
        return len(data)

    session.channel.send.side_effect = send_and_close
    session.read_task = asyncio.create_task(asyncio.sleep(10))
    await manager._write_loop(session)
    assert first.completion.result() == "sent"
    assert second.completion.result() == "sent"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_write_loop_failure_completes_a_control_request(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    request = module._ControlRequest(
        b"\x03", asyncio.get_running_loop().create_future()
    )
    session.control_queue.put_nowait(request)
    session.channel.send.side_effect = RuntimeError("write failed")
    await manager._write_loop(session)
    assert request.completion.result() == "failed"
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_write_loop_exits_after_an_idle_wakeup(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    task = asyncio.create_task(manager._write_loop(session))
    await asyncio.sleep(0)
    session.input_available.set()
    session.channel.closed = True
    await asyncio.wait_for(task, 1)
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_close_session_timeout_and_close_errors(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()
    session.read_task = asyncio.create_task(asyncio.sleep(10))
    with patch(
        "torrus.ssh_manager.asyncio.wait_for",
        new=AsyncMock(side_effect=asyncio.TimeoutError()),
    ):
        await manager._close_session(session)
    session.read_task.cancel()

    session = session_for()
    with patch(
        "torrus.ssh_manager._close_ssh_resources",
        side_effect=OSError("close failed"),
    ):
        await manager._close_session(session)
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_close_session_handles_an_already_removed_session(mock_sio):
    manager = SSHManager(mock_sio)
    session = session_for()

    await manager._close_session(session)
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_stop_background_tasks_skips_completed_tasks(mock_sio):
    manager = SSHManager(mock_sio)
    done = asyncio.create_task(asyncio.sleep(0))
    await done
    manager._tasks.append(done)

    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_disconnect_callback_failure_and_keepalive(mock_sio):
    callback = AsyncMock(side_effect=RuntimeError("callback failed"))
    manager = SSHManager(mock_sio, on_tab_disconnect=callback)
    await manager._notify_tab_disconnect(session_for())
    callback.assert_awaited_once()

    session = session_for()
    manager._sessions[("sess", "tab")] = session
    sleep = AsyncMock(side_effect=[None, asyncio.CancelledError()])
    with patch("torrus.ssh_manager.asyncio.sleep", sleep), pytest.raises(
        asyncio.CancelledError
    ):
        await manager._keepalive_loop()
    await manager.stop_background_tasks()


@pytest.mark.asyncio
async def test_cleanup_loop_skips_a_session_removed_concurrently(mock_sio):
    manager = SSHManager(mock_sio)
    manager._sessions[("sess", "tab")] = session_for(closed=True)
    sleep = AsyncMock(side_effect=[None, asyncio.CancelledError()])
    with (
        patch("torrus.ssh_manager.asyncio.sleep", sleep),
        patch.object(manager, "_pop_session_locked", return_value=None),
        pytest.raises(asyncio.CancelledError),
    ):
        await manager._cleanup_loop()


def test_blocking_helpers_cover_platform_edges():
    channel = MagicMock(closed=True)
    with pytest.raises(ConnectionError):
        _blocking_read(channel)

    channel = MagicMock(closed=False)
    channel.recv.return_value = b""
    with pytest.raises(ConnectionError, match="Remote process exited"):
        _blocking_read(channel)

    channel.recv.side_effect = TimeoutError()
    channel.exit_status_ready.return_value = True
    with pytest.raises(ConnectionError, match="Remote process exited"):
        _blocking_read(channel)

    channel.exit_status_ready.return_value = False
    assert _blocking_read(channel) == b""

    channel = MagicMock(closed=False)
    channel.send.return_value = 0
    with pytest.raises(ConnectionError, match="Failed to send"):
        _blocking_send_all(channel, b"x")

    channel = MagicMock(closed=True)
    with pytest.raises(ConnectionError):
        _blocking_send_all(channel, b"x")


def test_paramiko_helpers_close_every_stream():
    channels = [MagicMock(), MagicMock(), MagicMock()]
    streams = [MagicMock(channel=channel) for channel in channels]
    client = MagicMock()
    client.exec_command.return_value = streams
    streams[1].read.return_value = b"tmux\n"
    assert _check_tmux_blocking(client) is True
    for channel in channels:
        channel.close.assert_called_once()

    streams = [MagicMock(channel=MagicMock()) for _ in range(3)]
    client.exec_command.return_value = streams
    streams[1].read.return_value = b"1\n0\n"
    assert _connection_probes_blocking(client) == (True, True)

    streams[1].read.return_value = b"only-one-line\n"
    assert _connection_probes_blocking(client) == (False, False)


def test_paramiko_helpers_tolerate_streams_without_channels():
    stdin = SimpleNamespace(channel=None)
    stdout = SimpleNamespace(channel=None, read=MagicMock(return_value=b"tmux\n"))
    stderr = SimpleNamespace(channel=None)
    streams = [stdin, stdout, stderr]
    client = MagicMock()
    client.exec_command.return_value = streams
    assert _check_tmux_blocking(client) is True

    stdout.read.return_value = b"1\n0\n"
    assert _connection_probes_blocking(client) == (True, True)


def test_load_known_hosts_updates_the_client(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(module, "torrus_host_keys", lambda: {"host": "key"})

    module._load_known_hosts(client)

    client.load_system_host_keys.assert_called_once()
    client.get_host_keys.return_value.update.assert_called_once_with({"host": "key"})


def test_load_known_hosts_tolerates_missing_system_store(monkeypatch):
    client = MagicMock()
    client.load_system_host_keys.side_effect = OSError("missing")
    monkeypatch.setattr(module, "torrus_host_keys", dict)

    module._load_known_hosts(client)

    client.get_host_keys.return_value.update.assert_not_called()


def test_connect_helper_configures_transport_and_swallows_probe_failure():
    client = MagicMock()
    transport = MagicMock()
    client.get_transport.return_value = transport
    with patch("torrus.ssh_manager._connection_probes_blocking", return_value=(True, False)):
        assert _connect_and_check_tmux(client, "h", 22, "u", bytearray(b"p")) == (
            True,
            False,
        )
    assert transport.default_window_size == 16 * 1024 * 1024
    assert transport.default_max_packet_size == 128 * 1024

    client = MagicMock()
    client.get_transport.return_value = None
    with patch(
        "torrus.ssh_manager._connection_probes_blocking",
        side_effect=RuntimeError(),
    ):
        assert _connect_and_check_tmux(client, "h", 22, "u", b"p") == (False, False)

    class OldTransport:
        @property
        def default_window_size(self):
            return 0

        @default_window_size.setter
        def default_window_size(self, _value):
            raise AttributeError()

        @property
        def default_max_packet_size(self):
            return 0

        @default_max_packet_size.setter
        def default_max_packet_size(self, _value):
            raise AttributeError()

    client = MagicMock()
    client.get_transport.return_value = OldTransport()
    with patch("torrus.ssh_manager._connection_probes_blocking", return_value=(False, False)):
        assert _connect_and_check_tmux(client, "h", 22, "u", b"p") == (False, False)


def test_tmux_command_and_replay_sanitizing():
    client = MagicMock()
    channel = MagicMock()
    client.get_transport.return_value.open_session.return_value = channel
    assert _open_tmux_channel(client, "sc_name", 80, 24) is channel
    channel.exec_command.assert_called_once()

    assert _sanitize_replay_buffer(b"plain") == b"plain"
    assert _sanitize_replay_buffer(b"orphan\x1b[?1049lkeep") == b"keep"
    assert _sanitize_replay_buffer(b"\x1b[?1049hentry\x1b[?1049lexit") == (
        b"\x1b[?1049hentry\x1b[?1049lexit"
    )
    assert _sanitize_replay_buffer(
        b"\x1b[?1049lold\x1b[?1049lnew\x1b[?47lnewer"
    ) == b"newer"


def test_keepalive_and_resource_close_are_best_effort():
    transport = MagicMock()
    transport.is_active.return_value = True
    channel = MagicMock()
    channel.get_transport.return_value = transport
    _send_keepalive(session_for(channel=channel))
    transport.send_ignore.assert_called_once()

    transport.is_active.return_value = False
    _send_keepalive(session_for(channel=channel))

    channel = MagicMock()
    channel.get_transport.side_effect = RuntimeError()
    _send_keepalive(session_for(channel=channel))

    channel = MagicMock()
    channel.close.side_effect = RuntimeError("close")
    client = MagicMock()
    with pytest.raises(RuntimeError):
        _close_ssh_resources(channel, client)
    client.close.assert_called_once()


def test_host_key_policy_swallows_persist_errors(monkeypatch, tmp_path):
    import paramiko

    monkeypatch.setenv("TORRUS_SSH_HOST_KEY_POLICY", "accept-new")
    monkeypatch.setenv("TORRUS_SSH_KNOWN_HOSTS", str(tmp_path / "known_hosts"))
    policy = HostKeyPolicy()
    client = MagicMock()
    client.get_host_keys.return_value = paramiko.HostKeys()
    key = MagicMock()
    key.fingerprint = "SHA256:key"
    key.get_name.return_value = "ssh-ed25519"

    with patch("torrus.ssh_manager.Path.chmod", side_effect=OSError("chmod")):
        policy.missing_host_key(client, "example.com", key)

    assert "example.com" in (tmp_path / "known_hosts").read_text()


def test_known_hosts_default_uses_xdg_state_home(monkeypatch, tmp_path):
    monkeypatch.delenv("TORRUS_SSH_KNOWN_HOSTS", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    assert module.known_hosts_path() == tmp_path / "torrus" / "known_hosts"
