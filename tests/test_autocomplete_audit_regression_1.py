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
        await server_module._record_ssh_output_audit("session", "tab", b"me/")
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


@pytest.mark.asyncio
async def test_glob_completion_incremental_chunks_do_not_duplicate():
    """A path ending with `*` plus Tab must record the final glob state once.

    Regression: ISSUE-003 — admin audit split ``/hivestage/.../something/*``
    into two rows when bash re-drew the glob candidates in multiple output
    chunks. Each chunk used to append to the prior completion region, so the
    audit either duplicated candidates or, when interleaved with a stray
    Enter, fragmented the command. Completion output must now overwrite the
    prior completion region instead of appending.
    Found by /investigate on 2026-08-14
    """
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert (
            buffer.extract(
                b"/hivestage/frdv/frdv/timekey=something/countrycode=something/*\t"
            )
            == []
        )
        # Bash re-draws the glob in three incremental output chunks.
        await server_module._record_ssh_output_audit(
            "session", "tab", b" fileA.parquet"
        )
        await server_module._record_ssh_output_audit(
            "session", "tab", b" fileA.parquet fileB.parquet"
        )
        await server_module._record_ssh_output_audit(
            "session", "tab", b" fileA.parquet fileB.parquet fileC.parquet"
        )
        assert buffer.extract(b"\r") == [
            "/hivestage/frdv/frdv/timekey=something/countrycode=something/*"
            " fileA.parquet fileB.parquet fileC.parquet"
        ]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_late_output_after_enter_does_not_overwrite_audited_command():
    """ISSUE-guard: an SSH output chunk arriving after Enter must not mutate
    the already-submitted command or the buffer's completion zone.

    Regression guard: completion_pending is cleared by extract() on Enter, so
    observe_output()'s ``if not self.completion_pending`` guard short-circuits
    late chunks. completion_zone_start remains set but is harmless because the
    guard fires first; it is overwritten on the next Tab keystroke.
    """
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        # Match the existing completion pattern so the buffer reaches a known
        # audited state. After extract("user\\r") returns, the buffer is reset
        # and completion_pending is False.
        assert buffer.extract(b"cd /ho") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit("session", "tab", b"me")
        await server_module._record_ssh_output_audit("session", "tab", b"me/")
        assert buffer.extract(b"user\r") == ["cd /home/user"]

        # Late chunk arriving after submit must be a no-op.
        await server_module._record_ssh_output_audit(
            "session", "tab", b" injected-evil"
        )
        assert buffer.size == 0
        assert buffer.completion_pending is False
        assert buffer.completion_zone_start == 0
        # And the next extract produces no command.
        assert buffer.extract(b"\r") == []
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_redraw_completion_with_cr_prefix_is_captured():
    """A readline ``\\r`` redraw of the full completed line must contribute
    only the completion suffix, not the pre-tab text (which is already in the
    spool) and not a shell prompt.

    Regression: admin audit recorded ``cd /etc/ho`` instead of
    ``cd /etc/host`` because observe_output() discarded any chunk containing
    ``\\r``/``\\n``; bash wraps unique-completion redraws in ``\\r``.
    """
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert buffer.extract(b"cd /etc/ho") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit(
            "session", "tab", b"\rcd /etc/host"
        )
        assert buffer.extract(b"\r") == ["cd /etc/host"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_readline_redraw_with_prompt_keeps_only_completion_suffix():
    """Ambiguous-completion redraw (``\\r\\n`` listing + prompt + line) must
    not duplicate pre-tab text: only the non-prompt divergence is appended.
    """
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert buffer.extract(b"cat re") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit(
            "session",
            "tab",
            b"\r\nreadme.txt  requirements.txt\r\n$ cat re",
        )
        # Listing + prompt redraw added nothing; user's own disambiguation
        # typing must produce the final audited command.
        assert buffer.extract(b"adme.txt\r") == ["cat readme.txt"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_full_line_completion_echo_without_cr_prefix_is_captured():
    """Some shells echo the entire completed line without a ``\\r`` wrapper.
    A chunk that starts with the pending pre-tab input is a redraw and must
    contribute only the new suffix.
    """
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert buffer.extract(b"cd /etc/ho") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit("session", "tab", b"cd /etc/host")
        assert buffer.extract(b"\r") == ["cd /etc/host"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()


@pytest.mark.asyncio
async def test_suffix_echo_split_across_output_chunks_is_not_lost():
    """ISSUE-guard: a completion suffix echo split across two SSH output
    reads (``me`` then ``/``) must accumulate at the cursor. Replacing the
    zone on every bare chunk used to drop the first suffix and audit
    ``cd /ho/user`` instead of ``cd /home/user``.
    Found by user report on 2026-08-31.
    """
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


@pytest.mark.asyncio
async def test_cumulative_zone_reecho_appends_only_extension():
    """A bare chunk that re-echoes the already-echoed completion zone must
    contribute only its extension, never duplicate the zone content."""
    import torrus.server as server_module

    key = ("sid", "session", "tab")
    buffer = server_module._CommandInputBuffer()
    server_module._input_buffers[key] = buffer
    try:
        assert buffer.extract(b"cd /ho") == []
        assert buffer.extract(b"\t") == []
        await server_module._record_ssh_output_audit("session", "tab", b"me")
        await server_module._record_ssh_output_audit("session", "tab", b"me/")
        assert buffer.extract(b"user\r") == ["cd /home/user"]
    finally:
        server_module._input_buffers.pop(key, None)
        buffer.close()
