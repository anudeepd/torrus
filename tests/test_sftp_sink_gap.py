"""The SFTP sink must never park a write forever behind a gap nobody will fill."""

import asyncio

import pytest

from torrus import sftp_manager
from torrus.sftp_manager import SFTPSink
from torrus.upload_engine import UploadSinkError

MB = 1024 * 1024


class FakeChannel:
    def __init__(self):
        self.received = bytearray()

    def sendall(self, data):
        self.received += data


async def _run_blocking(fn, *args):
    return fn(*args)


def _sink() -> SFTPSink:
    sink = SFTPSink.__new__(SFTPSink)
    sink._manager = None
    sink._tab_id = "tab"
    sink._client = None
    sink._staging = "/staging"
    sink._destination = "/dest"
    sink._replaced = "/replaced"
    sink._run = _run_blocking
    sink._channel = FakeChannel()
    sink._streamed = 0
    sink._pending = {}
    sink._pending_bytes = 0
    sink._failure = None
    sink._lock = asyncio.Lock()
    sink._cond = asyncio.Condition(sink._lock)
    sink._client_closed = False
    sink._closed = False
    return sink


def _bytes(offset: int, size: int) -> bytes:
    return bytes((offset + i) % 251 for i in range(size))


@pytest.fixture(autouse=True)
def _small_buffer(monkeypatch):
    monkeypatch.setattr(sftp_manager, "_SINK_PENDING_MAX_BYTES", 2 * MB)
    monkeypatch.setattr(sftp_manager, "_SINK_GAP_WAIT_SECONDS", 0.2)


async def _fill_buffer_behind_a_gap(sink: SFTPSink) -> None:
    """Hold 2 MB of windows above a hole at [0, MB)."""
    await sink.write_at(MB, _bytes(MB, MB))
    await sink.write_at(2 * MB, _bytes(2 * MB, MB))
    assert sink._pending_bytes == 2 * MB


async def test_a_write_behind_a_full_buffer_gives_up_with_a_retryable_error():
    sink = _sink()
    await _fill_buffer_behind_a_gap(sink)

    with pytest.raises(UploadSinkError) as raised:
        await asyncio.wait_for(sink.write_at(3 * MB, _bytes(3 * MB, MB)), 5)

    assert raised.value.status == 503
    assert raised.value.code == "SINK_ERROR"
    # The sink itself is still healthy and keeps what it already holds.
    assert sink._failure is None
    assert sink._pending_bytes == 2 * MB


async def test_filling_the_gap_releases_a_parked_write_and_streams_in_order(
    monkeypatch,
):
    sink = _sink()
    await _fill_buffer_behind_a_gap(sink)
    monkeypatch.setattr(sftp_manager, "_SINK_GAP_WAIT_SECONDS", 5)

    parked = asyncio.create_task(sink.write_at(3 * MB, _bytes(3 * MB, MB)))
    await asyncio.sleep(0.05)
    assert not parked.done()

    await sink.write_at(0, _bytes(0, MB))
    await asyncio.wait_for(parked, 5)

    assert bytes(sink._channel.received) == b"".join(
        _bytes(i * MB, MB) for i in range(4)
    )
    assert sink._pending == {}


async def test_the_sink_still_accepts_the_gap_after_a_writer_gave_up():
    sink = _sink()
    await _fill_buffer_behind_a_gap(sink)
    with pytest.raises(UploadSinkError):
        await sink.write_at(3 * MB, _bytes(3 * MB, MB))

    await sink.write_at(0, _bytes(0, MB))

    assert sink._streamed == 3 * MB
