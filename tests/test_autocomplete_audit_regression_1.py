"""Regression coverage for shell-completed command auditing."""

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_inline_tab_completion_is_included_in_audited_command():
    """Remote completion suffixes must become part of submitted command text."""
    # Regression: ISSUE-002 — admin audit saw Tab input but not shell completion output
    # Found by /qa on 2026-08-03
    # Report: .gstack/qa-reports/qa-report-torrus-2026-08-03.md
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert buffer.extract(b"cd /ho") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit("session", "tab", b"me")
        await server_module._record_ssh_output_audit("session", "tab", b"/")
        assert buffer.extract(b"user\r") == ["cd /home/user"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


def test_bracketed_bulk_paste_preserves_markers_and_literal_tabs():
    """Bulk paste markers must not leak into or alter audited commands."""
    import torrus.server as server_module

    buffer = server_module._CommandInputBuffer()
    try:
        assert buffer.extract(b"\x1b[20") == []
        assert buffer.extract(b'0~if true; then\recho\t"bulk"\rfi\x1b[201~\r') == [
            "if true; then",
            'echo\t"bulk"',
            "fi",
        ]
    finally:
        buffer.close()


def test_bracketed_bulk_paste_state_spans_input_chunks():
    """Split Socket.IO chunks must retain bracketed-paste state."""
    import torrus.server as server_module

    buffer = server_module._CommandInputBuffer()
    try:
        assert buffer.extract(b"\x1b[200~echo one\r") == ["echo one"]
        assert buffer.extract(b"echo\t two\x1b[201~\r") == ["echo\t two"]
    finally:
        buffer.close()


@pytest.mark.asyncio
async def test_completion_listing_is_not_mistaken_for_command_text():
    """Multiline completion choices must stay terminal output, not audit input."""
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        buffer.extract(b"cat re")
        buffer.extract(b"\t")
        await server_module._record_ssh_output_audit(
            "session", "tab", b"\r\nreadme.txt  requirements.txt\r\n$ cat re"
        )
        assert buffer.extract(b"adme.txt\r") == ["cat readme.txt"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_ssh_read_loop_forwards_output_to_audit_callback(mock_sio):
    """SSH output must reach command reconstruction before browser delivery."""
    from torrus.ssh_manager import SSHManager, SSHSession

    on_output = AsyncMock()
    manager = SSHManager(mock_sio, on_output=on_output)
    channel = MagicMock(closed=False)

    def recv(_size):
        channel.closed = True
        return b"me/"

    channel.recv.side_effect = recv
    session = SSHSession(
        session_id="session",
        tab_id="tab",
        client=MagicMock(),
        channel=channel,
        host="example.com",
        port=22,
        username="alice",
    )

    try:
        await manager._read_loop(session)
        on_output.assert_awaited_once_with("session", "tab", b"me/")
        assert mock_sio.emit.await_args_list[0].args[0] == "ssh:output"
    finally:
        await manager.stop_background_tasks()
