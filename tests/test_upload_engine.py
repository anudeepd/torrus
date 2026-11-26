"""Coverage for the chunked-upload engine and its HTTP contract."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from torrus.upload_engine import (
    DEFAULT_CHUNK_SIZE,
    AuthContext,
    RangeTracker,
    UploadSinkError,
    UploadStore,
    UploadTarget,
    create_upload_router,
    is_staging_name,
    staging_name,
    stream_to_sink,
)


class Sink:
    def __init__(self, *, fail: Exception | None = None):
        self.writes: list[tuple[int, bytes]] = []
        self.finalized = 0
        self.aborted = 0
        self.fail = fail

    async def write_at(self, offset: int, data: bytes) -> None:
        if self.fail:
            raise self.fail
        self.writes.append((offset, data))

    async def finalize(self) -> None:
        self.finalized += 1

    async def abort(self) -> None:
        self.aborted += 1


def target(
    *,
    session_id: str = "a" * 32,
    size: int = 10,
    filename: str = "file.bin",
) -> UploadTarget:
    return UploadTarget(
        session_id=session_id,
        user="alice",
        directory="/home/alice",
        filename=filename,
        size=size,
    )


def request_for(*chunks: bytes):
    async def stream():
        for chunk in chunks:
            yield chunk

    return SimpleNamespace(stream=stream)


def app_with_router(
    *,
    target_factory=None,
    sink_factory=None,
    on_complete=None,
    store=None,
    user="alice",
):
    store = store or UploadStore()
    open_target = target_factory or AsyncMock(return_value=target())
    open_sink = sink_factory or AsyncMock(return_value=Sink())
    app = FastAPI()
    app.include_router(
        create_upload_router(
            store=store,
            authorize=AsyncMock(return_value=AuthContext(user=user)),
            open_target=open_target,
            open_sink=open_sink,
            on_complete=on_complete,
        )
    )
    return app, store, open_target, open_sink


def test_byte_ranges_merge_and_report_gaps():
    tracker = RangeTracker([[5, 8], [1, 2]])
    tracker.add(2, 5)
    tracker.add(7, 10)
    tracker.add(10, 10)
    separated = RangeTracker([[1, 2]])
    separated.add(3, 4)

    assert tracker.spans() == [(1, 10)]
    assert separated.spans() == [(1, 2), (3, 4)]
    assert tracker.to_json() == [[1, 10]]
    assert tracker.total() == 9
    assert RangeTracker([[0, 10]]).covers(10)
    assert not tracker.covers(9)
    assert tracker.missing(10) == [(0, 1)]
    assert RangeTracker([[0, 9]]).covers(9)

    empty = RangeTracker()
    assert empty.covers(0)
    assert empty.missing(4) == [(0, 4)]
    assert not RangeTracker([[1, 3]]).covers(0)
    assert RangeTracker([[1, 3], [5, 7]]).missing(9) == [(0, 1), (3, 5), (7, 9)]
    assert RangeTracker([[1, 2], [10, 11], [20, 21], [4, 5]]).spans() == [
        (1, 2),
        (4, 5),
        (10, 11),
        (20, 21),
    ]
    assert RangeTracker([[0, 2], [2, 4]]).missing(4) == []


def test_staging_names_are_identifiable():
    name = staging_name("report.csv", "abc")
    assert name == ".report.csv.upload-part-abc"
    assert is_staging_name(name)
    assert not is_staging_name("report.csv")


@pytest.mark.asyncio
async def test_store_registers_evicts_expires_and_aborts(monkeypatch):
    first_sink = Sink()
    evicted_sink = Sink()
    store = UploadStore(
        ttl_seconds=5,
        chunk_size=1,
        concurrency=0,
        max_sessions=2,
    )
    first = await store.register(target(session_id="1" * 32, size=1), user="alice")
    first.sink = first_sink
    second = await store.register(target(session_id="2" * 32, size=2), user="bob")
    second.sink = evicted_sink

    third = await store.register(target(session_id="3" * 32, size=3), user="alice")
    assert third.session_id == "3" * 32
    assert first_sink.aborted == 1
    assert store.user_session_count("alice") == 1
    assert store.user_session_count(None) == 0
    assert store.chunk_size == 1024 * 1024
    assert store.concurrency == 1

    monkeypatch.setattr("torrus.upload_engine.time.time", lambda: third.updated_at + 6)
    assert store.get(third.session_id) is None
    store.touch(second)
    assert await store.sweep() == 1
    assert store.user_session_count("alice") == 0

    fourth = await store.register(target(session_id="4" * 32), user="alice")
    fourth.sink = Sink()
    await store.drop("missing")
    await store.drop(fourth.session_id)
    assert fourth.sink is None

    fifth = await store.register(target(session_id="5" * 32), user="alice")
    fifth.sink = Sink()
    await store.close()
    assert store.get(fifth.session_id) is None


@pytest.mark.asyncio
async def test_abort_failures_are_logged_and_disabled_aborts_are_skipped():
    store = UploadStore()
    session = await store.register(target(), user=None)

    class BrokenSink(Sink):
        async def abort(self) -> None:
            raise RuntimeError("abort failed")

    session.sink = BrokenSink()
    await store.drop(session.session_id)
    assert session.sink is None

    disabled = await store.register(target(session_id="b" * 32), user=None)
    disabled.sink = Sink()
    await store.drop(disabled.session_id, abort=False)
    assert disabled.sink.aborted == 0

    empty = await store.register(target(session_id="c" * 32), user=None)
    await store.drop(empty.session_id)


def test_store_defaults_and_chunk_clamping():
    store = UploadStore(chunk_size=999)
    assert store.chunk_size == 1024 * 1024
    assert UploadStore(chunk_size=999_999_999).chunk_size == 64 * 1024 * 1024
    assert UploadStore(chunk_size="bad").chunk_size == DEFAULT_CHUNK_SIZE
    assert UploadStore(chunk_size=None).chunk_size == DEFAULT_CHUNK_SIZE
    assert len(store.new_session_id()) == 32


@pytest.mark.asyncio
async def test_stream_to_sink_enforces_both_size_limits():
    sink = Sink()
    assert await stream_to_sink(request_for(b"", b"abc"), sink, max_bytes=3) == 3
    assert sink.writes == [(0, b"abc")]

    sink = Sink()
    assert await stream_to_sink(
        request_for(b"a", b"bc"), sink, max_bytes=10, offset=4, expect_length=3
    ) == 3
    assert sink.writes == [(4, b"a"), (5, b"bc")]

    with pytest.raises(HTTPException) as exc:
        await stream_to_sink(request_for(b"abcd"), Sink(), max_bytes=3)
    assert exc.value.status_code == 413

    with pytest.raises(HTTPException, match="declared size"):
        await stream_to_sink(
            request_for(b"abcd"), Sink(), max_bytes=10, expect_length=3
        )

    with pytest.raises(HTTPException, match="shorter"):
        await stream_to_sink(
            request_for(b"ab"), Sink(), max_bytes=10, expect_length=3
        )


def test_upload_router_validates_init_and_reports_limits():
    app, store, _, _ = app_with_router()
    store.max_sessions_per_user = 0
    with TestClient(app) as client:
        assert client.post("/_upload/init", data="{bad").status_code == 400
        assert client.post("/_upload/init", json=[]).status_code == 400

    app, store, _, _ = app_with_router()
    store.max_sessions_per_user = 1
    store._sessions["existing"] = SimpleNamespace(user="alice")
    with TestClient(app) as client:
        assert client.post("/_upload/init", json={}).status_code == 429

    app, _, _, _ = app_with_router(
        target_factory=AsyncMock(return_value={"ignored": True})
    )
    with TestClient(app) as client:
        response = client.post("/_upload/init", json={})
        assert response.status_code == 200
        assert response.json() == {"ignored": True}

    for value, status in ((-1, 400), (11, 413)):
        app, _, _, _ = app_with_router(
            target_factory=AsyncMock(return_value=target(size=value)),
            store=UploadStore(max_session_bytes=10),
        )
        with TestClient(app) as client:
            assert client.post("/_upload/init", json={}).status_code == status

    app, _, _, _ = app_with_router()
    with TestClient(app) as client:
        assert client.post("/_upload/init", json={}).status_code == 200


def test_upload_router_session_ownership_and_offsets():
    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=4), user="bob"))
    with TestClient(app) as client:
        assert client.get("/_upload/not-a-session").status_code == 404
        assert client.get("/_upload/" + "f" * 32).status_code == 404
        assert client.get(f"/_upload/{session.session_id}").status_code == 403

    app, store, _, open_sink = app_with_router()
    session = asyncio.run(store.register(target(size=4), user="alice"))
    with TestClient(app) as client:
        assert client.get(f"/_upload/{session.session_id}").status_code == 200
        assert (
            client.put(
                f"/_upload/{session.session_id}?offset=bad", content=b"x"
            ).status_code
            == 400
        )
        assert (
            client.put(
                f"/_upload/{session.session_id}?offset=5", content=b"x"
            ).status_code
            == 400
        )
        session.closing = True
        assert (
            client.put(f"/_upload/{session.session_id}", content=b"x").status_code
            == 409
        )
        session.closing = False
        response = client.put(f"/_upload/{session.session_id}", content=b"abcd")
        assert response.status_code == 200
        assert response.json()["received"] == 4
        open_sink.assert_awaited_once()


def test_upload_router_stream_errors_and_limits():
    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=2), user="alice"))
    with TestClient(app) as client:
        assert (
            client.put(f"/_upload/{session.session_id}", content=b"abc").status_code
            == 413
        )

    app, store, _, _ = app_with_router()
    store.max_session_bytes = 1
    session = asyncio.run(store.register(target(size=4), user="alice"))
    with TestClient(app) as client:
        assert (
            client.put(f"/_upload/{session.session_id}", content=b"ab").status_code
            == 413
        )

    for error, status in (
        (UploadSinkError("refused", code="REFUSED", status=409), 409),
        (RuntimeError("boom"), 502),
    ):
        app, store, _, _ = app_with_router(
            sink_factory=AsyncMock(return_value=Sink(fail=error))
        )
        session = asyncio.run(store.register(target(size=2), user="alice"))
        with TestClient(app) as client:
            response = client.put(f"/_upload/{session.session_id}", content=b"ab")
            assert response.status_code == status

    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=2), user="alice"))
    session.sink = Sink()
    with TestClient(app) as client:
        session.closing = True
        assert (
            client.put(f"/_upload/{session.session_id}", content=b"ab").status_code
            == 409
        )

    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=2), user="alice"))

    class ClosingSink(Sink):
        async def write_at(self, offset: int, data: bytes) -> None:
            await super().write_at(offset, data)
            session.closing = True

    session.sink = ClosingSink()
    with TestClient(app) as client:
        assert (
            client.put(f"/_upload/{session.session_id}", content=b"ab").status_code
            == 409
        )


def test_upload_router_complete_paths():
    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=2), user="alice"))
    with TestClient(app) as client:
        session.closing = True
        assert (
            client.post(f"/_upload/{session.session_id}/complete").status_code == 409
        )
        session.closing = False
        assert (
            client.post(f"/_upload/{session.session_id}/complete").status_code == 400
        )
        session.ranges.add(0, 2)
        assert (
            client.post(f"/_upload/{session.session_id}/complete").status_code == 400
        )

    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=0), user="alice"))
    with TestClient(app) as client:
        response = client.post(f"/_upload/{session.session_id}/complete")
        assert response.status_code == 200
        assert response.json() == {"path": "file.bin", "size": 0}
        assert session.sink is not None
        assert session.sink.finalized == 1

    app, store, _, _ = app_with_router(
        sink_factory=AsyncMock(
            side_effect=HTTPException(status_code=403, detail="denied")
        )
    )
    session = asyncio.run(store.register(target(size=0), user="alice"))
    with TestClient(app) as client:
        assert (
            client.post(f"/_upload/{session.session_id}/complete").status_code == 403
        )

    for error, status in ((HTTPException(status_code=403), 403), (RuntimeError("x"), 500)):
        sink = Sink()
        sink.finalize = AsyncMock(side_effect=error)
        app, store, _, _ = app_with_router(
            sink_factory=AsyncMock(return_value=sink)
        )
        session = asyncio.run(store.register(target(size=0), user="alice"))
        with TestClient(app) as client:
            assert (
                client.post(f"/_upload/{session.session_id}/complete").status_code
                == status
            )


def test_upload_router_completion_hook_failure_and_cancel():
    on_complete = AsyncMock(side_effect=RuntimeError("hook failed"))
    app, store, _, _ = app_with_router(on_complete=on_complete)
    session = asyncio.run(store.register(target(size=0), user="alice"))
    with TestClient(app) as client:
        assert (
            client.post(f"/_upload/{session.session_id}/complete").status_code == 200
        )
    on_complete.assert_awaited_once()

    app, store, _, _ = app_with_router()
    session = asyncio.run(store.register(target(size=2), user="alice"))
    with TestClient(app) as client:
        assert client.delete(f"/_upload/{session.session_id}").status_code == 200
        assert store.get(session.session_id) is None
