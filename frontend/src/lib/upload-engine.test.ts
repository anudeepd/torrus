import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadClient,
  UploadError,
  UploadState,
  committedBytes,
  SpeedTracker,
  missingRanges,
  planWindows,
  uploadFile,
} from '@/lib/upload-engine';

interface ProgressLike {
  loaded: number;
  total?: number;
}

/**
 * Controllable XMLHttpRequest stand-in.
 *
 * `uploadAbort` dispatches asynchronously, exactly like the browser, so tests
 * prove the engine settles on its own reason rather than on event ordering.
 */
class FakeXHR {
  static all: FakeXHR[] = [];

  status = 0;
  method = "";
  url = "";
  body: Blob | null = null;
  aborted = false;
  responseText = "";

  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  private uploadListeners = new Map<string, Array<(event: ProgressLike) => void>>();

  upload = {
    addEventListener: (type: string, handler: (event: ProgressLike) => void): void => {
      const handlers = this.uploadListeners.get(type) ?? [];
      handlers.push(handler);
      this.uploadListeners.set(type, handlers);
    },
  };

  constructor() {
    FakeXHR.all.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(): void {}

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: Blob): void {
    this.body = body;
    this.dispatchUpload("loadstart", { loaded: 0 });
  }

  abort(): void {
    this.aborted = true;
    queueMicrotask(() => this.dispatch("abort"));
  }

  progress(loaded: number, total: number): void {
    this.dispatchUpload("progress", { loaded, total });
  }

  /** The browser finished sending the body; the response is still pending. */
  bodySent(): void {
    this.dispatchUpload("load", { loaded: this.body?.size ?? 0 });
  }

  uploadError(): void {
    this.dispatchUpload("error", { loaded: 0 });
  }

  networkError(): void {
    this.dispatch("error");
  }

  timeoutError(): void {
    this.dispatch("timeout");
  }

  abortNow(): void {
    this.dispatch("abort");
  }

  finish(status: number, payload: unknown = { ranges: [[0, 0]] }): void {
    this.status = status;
    this.responseText = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.dispatch("load");
  }

  private dispatch(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  private dispatchUpload(type: string, event: ProgressLike): void {
    for (const handler of this.uploadListeners.get(type) ?? []) handler(event);
  }
}

/** Client whose `complete` call succeeds unless a test overrides it. */
function completingFetch() {
  return vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<unknown>>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ path: "file.bin" }),
  }));
}

function client(): UploadClient {
  return new UploadClient({ base: "/_upload", fetchImpl: completingFetch() as unknown as typeof fetch });
}

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

/** Drive an engine call far enough to create the first XHR. */
/** Let queued microtasks and one macrotask run under real timers. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function startUpload(overrides: Record<string, unknown> = {}) {
  const states: string[] = [];
  const progress: number[] = [];
  const promise = uploadFile({
    client: client(),
    file: blobOf(8),
    destDir: "/",
    session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 8 },
    chunkSize: 4,
    minChunkBytes: 4,
    concurrency: 1,
    backoffMs: [1, 1, 1],
    callbacks: {
      onState: (state: string) => states.push(state),
      onProgress: (committed: number) => progress.push(committed),
      onRetry: () => {},
    },
    ...overrides,
  });
  await Promise.resolve();
  return { promise, states, progress };
}

beforeEach(() => {
  FakeXHR.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SpeedTracker", () => {
  it("computes bytes per second across the sampled window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const tracker = new SpeedTracker();
    expect(tracker.speed()).toBe(0);
    tracker.sample(0);
    now.mockReturnValue(2_000);
    tracker.sample(10_000);
    expect(tracker.speed()).toBe(10_000);
    now.mockReturnValue(3_000);
    tracker.sample(25_000);
    expect(tracker.speed()).toBe(12_500);
    now.mockRestore();
  });

  it("drops samples older than the sliding window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const tracker = new SpeedTracker();
    tracker.sample(0);
    now.mockReturnValue(6_000);
    tracker.sample(6_000);
    now.mockReturnValue(7_000);
    tracker.sample(10_000);
    expect(tracker.speed()).toBe(4_000);
    now.mockRestore();
  });

  it("returns zero when samples share a timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const tracker = new SpeedTracker();
    tracker.sample(0);
    tracker.sample(10);
    expect(tracker.speed()).toBe(0);
  });
});

describe("range planning", () => {
  it("reports the gaps the server has not got yet", () => {
    expect(missingRanges([], 10)).toEqual([[0, 10]]);
    expect(missingRanges([[0, 4], [8, 10]], 10)).toEqual([[4, 8]]);
    expect(missingRanges([[0, 10]], 10)).toEqual([]);
    expect(missingRanges([[0, 4], [4, 10]], 10)).toEqual([]);
    expect(missingRanges([[0, 4], [6, 10], [2, 2], [NaN, 4]], 10)).toEqual([
      [4, 6],
    ]);
    expect(missingRanges(null, 0)).toEqual([]);
  });

  it("splits gaps into equal windows and keeps the remainder", () => {
    expect(planWindows([], 10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(planWindows([[4, 8]], 10, 4)).toEqual([
      [0, 4],
      [8, 10],
    ]);
  });

  it("counts committed bytes", () => {
    expect(committedBytes([[0, 4], [8, 10]])).toBe(6);
    expect(committedBytes(null)).toBe(0);
  });
});

describe("UploadClient", () => {
  it("appends client-wide query parameters to every request", async () => {
    const fetchImpl = completingFetch();
    const client = new UploadClient({
      base: "/_upload",
      params: { session_id: "session-b", tab_id: "tab-a" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.initWithRetry({ filename: "a.bin", size: 1, dir: "/" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/_upload/init?session_id=session-b&tab_id=tab-a");

    await client.complete("abc");
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      "/_upload/abc/complete?session_id=session-b&tab_id=tab-a",
    );

    const put = client.put("abc", 7, blobOf(1));
    const xhr = FakeXHR.all[0]!;
    expect(xhr.url).toBe("/_upload/abc?session_id=session-b&tab_id=tab-a&offset=7");
    const resolvedUrl = new URL(xhr.url, window.location.href);
    expect(resolvedUrl.protocol).toBe("http:");
    expect(resolvedUrl.origin).toBe(window.location.origin);
    xhr.finish(200, { ranges: [[7, 8]] });
    await put;
  });

  it("maps non-JSON failures for init, status, and complete", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("html");
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ code: "UPLOAD_INCOMPLETE", message: "missing" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("html");
        },
      });
    const client = new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.initWithRetry({ filename: "x", size: 1, dir: "/" }))
      .rejects.toMatchObject({ status: 502, code: "UPLOAD_FAILED", retryable: true });
    await expect(client.status("abc")).rejects.toMatchObject({
      status: 404,
      code: "UPLOAD_INCOMPLETE",
    });
    await expect(client.complete("abc")).rejects.toMatchObject({ status: 500 });

    const statusWithoutJson = new UploadClient({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("html");
        },
      }) as unknown as typeof fetch,
    });
    await expect(statusWithoutJson.status("abc")).rejects.toMatchObject({
      status: 500,
    });

    const jsonError = new UploadClient({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ code: "SINK_ERROR", message: "busy" }),
      }) as unknown as typeof fetch,
    });
    await expect(jsonError.initWithRetry({ filename: "x", size: 1, dir: "/" }))
      .rejects.toMatchObject({ status: 429, code: "SINK_ERROR", retryable: true });
  });

  it("makes cancellation best effort", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const client = new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.cancel("abc")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("/_upload/abc", expect.objectContaining({ method: "DELETE" }));

    const offline = new UploadClient({
      fetchImpl: vi.fn().mockRejectedValue("offline") as unknown as typeof fetch,
    });
    await expect(offline.cancel("abc")).resolves.toBeUndefined();

    const defaults = new UploadClient();
    expect(defaults.base).toBe("/_upload");
    expect(defaults.params).toBeNull();
    expect(typeof defaults.fetchImpl).toBe("function");

    const fetchDefault = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ranges: [] }),
    });
    vi.stubGlobal("fetch", fetchDefault);
    await new UploadClient().status("default");
    expect(fetchDefault).toHaveBeenCalled();
  });

  it("prefers a request signal over the client signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const clientSignal = new AbortController();
    const requestSignal = new AbortController();
    const client = new UploadClient({
      params: { a: "1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: clientSignal.signal,
    });
    await client.initWithRetry({ filename: "x", size: 1, dir: "/" });
    expect(fetchImpl.mock.calls[0][1].signal).toBe(clientSignal.signal);
    await client.status("abc").catch(() => {});
    const request = client.put("abc", 0, blobOf(1), { signal: requestSignal.signal });
    FakeXHR.all.at(-1)!.finish(200, { ranges: [[0, 1]] });
    await request;
  });

  it("rejects a put started with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const put = client().put("abc", 0, blobOf(1), { signal: controller.signal });
    await expect(put).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("reports upload, network, timeout, and XHR abort events", async () => {
    const cases = async (event: (xhr: FakeXHR) => void, code: string) => {
      const put = client().put("abc", 0, blobOf(1));
      const xhr = FakeXHR.all.at(-1)!;
      event(xhr);
      await expect(put).rejects.toMatchObject({ code });
    };
    await cases(xhr => xhr.uploadError(), "NETWORK");
    await cases(xhr => xhr.networkError(), "NETWORK");
    await cases(xhr => xhr.timeoutError(), "TIMEOUT");
    await cases(xhr => xhr.abortNow(), "ABORTED");
  });

  it("does not let a throwing abort mask the original failure", async () => {
    const controller = new AbortController();
    const put = client().put("abc", 0, blobOf(1), { signal: controller.signal });
    const xhr = FakeXHR.all.at(-1)!;
    xhr.abort = () => {
      throw new Error("abort already finished");
    };
    controller.abort();
    await expect(put).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("uploadFile", () => {
  it("sends each planned window and completes", async () => {
    const { promise } = await startUpload();
    expect(FakeXHR.all).toHaveLength(1);
    expect(FakeXHR.all[0]!.url).toBe("/_upload/session?offset=0");

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toBe("/_upload/session?offset=4");

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("shrinks a rejected 1 MB upload below the proxy body limit", async () => {
    const size = 1_000_000;
    const { promise } = await startUpload({
      file: blobOf(size),
      chunkSize: size,
      maxChunkBytes: size,
      concurrency: 1,
      session: { uploadId: "session", chunkSize: size, concurrency: 1, ranges: [], size },
    });
    expect(FakeXHR.all).toHaveLength(1);
    expect(FakeXHR.all[0]!.body!.size).toBe(size);

    // Model a reverse proxy rejecting the raw PUT before it reaches Torrus or SSH.
    FakeXHR.all[0]!.finish(413, "Request Entity Too Large");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(500_000);

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 500_000]], received: 500_000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    expect(FakeXHR.all[2]!.url).toContain("offset=500000");
    expect(FakeXHR.all[2]!.body!.size).toBe(500_000);
    FakeXHR.all[2]!.finish(200, { ranges: [[0, size]], received: 500_000 });

    await expect(promise).resolves.toMatchObject({ ok: true, bytes: size });
  });

  it("skips windows the server already holds", async () => {
    const { promise } = await startUpload({
      session: { uploadId: "s", chunkSize: 4, concurrency: 1, ranges: [[0, 4]], size: 8 },
    });
    expect(FakeXHR.all).toHaveLength(1);
    expect(FakeXHR.all[0]!.url).toBe("/_upload/s?offset=4");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("retries a failed window and shrinks it after repeated failures", async () => {
    const retries: number[] = [];
    const { promise } = await startUpload({
      file: blobOf(4000),
      chunkSize: 4000,
      minChunkBytes: 100,
      maxChunkBytes: 4000,
      concurrency: 1,
      callbacks: { onRetry: (info: { attempt: number }) => retries.push(info.attempt) },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0]!.body!.size).toBe(4000);

    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(4000);
    expect(retries).toEqual([1]);

    FakeXHR.all[1]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    // Fourth attempt onwards halves the window so a slow link can finish it.
    FakeXHR.all[2]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.body!.size).toBeLessThan(4000);

    FakeXHR.all[3]!.finish(200, { ranges: [[0, 2000]], received: 2000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(5));
    expect(FakeXHR.all[4]!.url).toContain("offset=2000");
    FakeXHR.all[4]!.finish(200, { ranges: [[0, 4000]], received: 2000 });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("sends the tail a shrunk window gave up before starting later windows", async () => {
    const { promise } = await startUpload({
      file: blobOf(12000),
      chunkSize: 4000,
      minChunkBytes: 100,
      maxChunkBytes: 4000,
      concurrency: 2,
      session: { uploadId: "session", chunkSize: 4000, concurrency: 2, ranges: [], size: 12000 },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[0]!.url).toContain("offset=0");
    expect(FakeXHR.all[1]!.url).toContain("offset=4000");

    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    FakeXHR.all[2]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.body!.size).toBe(2000);

    // The other worker frees up first. The abandoned half of window 0 must be
    // next, not window 2: an in-order sink would otherwise stall behind the gap.
    FakeXHR.all[1]!.finish(200, { ranges: [[4000, 8000]], received: 4000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(5));
    expect(FakeXHR.all[4]!.url).toContain("offset=2000");

    void promise.catch(() => {});
  });

  it("gives up after the attempt budget and keeps the server's ranges", async () => {
    const progress: number[] = [];
    const { promise } = await startUpload({
      maxAttempts: 2,
      backoffMs: [1],
      callbacks: { onProgress: (committed: number) => progress.push(committed) },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(500);

    await expect(promise).rejects.toBeInstanceOf(UploadError);
    expect(progress).toContain(0);
  });

  it("does not retry a non-retryable rejection", async () => {
    const { promise } = await startUpload();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(403, { detail: "Not permitted" });

    await expect(promise).rejects.toMatchObject({ status: 403, retryable: false });
    expect(FakeXHR.all).toHaveLength(1);
  });

  it("surfaces a finalize failure instead of retrying a session the server dropped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        code: "server_error",
        message: "Upload finalize failed: Permission denied",
      }),
    });
    const { promise } = await startUpload({
      client: new UploadClient({ base: "/_upload", fetchImpl: fetchImpl as unknown as typeof fetch }),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [[0, 8]], size: 8 },
    });

    await expect(promise).rejects.toMatchObject({
      status: 500,
      message: "Upload finalize failed: Permission denied",
    });
    const completeCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/complete"));
    expect(completeCalls).toHaveLength(1);
  });

  it("reports a 2xx that is not the JSON envelope instead of accepting it", async () => {
    const { promise } = await startUpload();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    // An authenticated redirect followed by XHR lands here as the login page.
    FakeXHR.all[0]!.finish(200, "<!doctype html><title>Sign in</title>");

    await expect(promise).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("restarts once when the session is gone", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ upload_id: "fresh", chunk_size: 4, concurrency: 1, size: 8 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ path: "file.bin" }) });
    const retries: string[] = [];
    const { promise } = await startUpload({
      client: new UploadClient({ base: "/_upload", fetchImpl: fetchImpl as unknown as typeof fetch }),
      callbacks: { onRetry: (info: { code: string; message: string }) => retries.push(`${info.code}:${info.message}`) },
    });
    expect(FakeXHR.all).toHaveLength(1);

    FakeXHR.all[0]!.finish(404, { detail: "Upload session not found" });
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith("/_upload/init", expect.anything());
    expect(FakeXHR.all).toHaveLength(2);
    expect(FakeXHR.all[1]!.url).toBe("/_upload/fresh?offset=0");

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await flush();
    expect(FakeXHR.all[2]!.url).toBe("/_upload/fresh?offset=4");
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await flush();
    expect(retries).toEqual([]);
    await expect(promise).resolves.toMatchObject({ ok: true, uploadId: "fresh", restarted: true });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const { promise } = await startUpload({ signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    expect(FakeXHR.all[0]!.aborted).toBe(true);
  });

  it("moves to the processing phase once the body is sent", async () => {
    const states: string[] = [];
    await startUpload({ callbacks: { onState: (state: string) => states.push(state) } });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.bodySent();
    expect(states).toContain(UploadState.PROCESSING);
  });

  it("publishes the resumable session and accepts a received-only response", async () => {
    const sessions: unknown[] = [];
    const { promise } = await startUpload({
      callbacks: {
        onSession: (session: unknown) => sessions.push(session),
      },
    });
    expect(sessions).toHaveLength(1);
    FakeXHR.all[0]!.finish(200, { received: 4 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await expect(promise).resolves.toMatchObject({ ok: true, path: "file.bin" });
    expect(sessions.length).toBeGreaterThan(1);
  });

  it("retries a retryable finalize response", async () => {
    let completes = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("/complete")) return { ok: true, json: async () => ({}) };
      completes += 1;
      return completes === 1
        ? { ok: false, status: 503, json: async () => ({ message: "busy" }) }
        : { ok: true, status: 200, json: async () => ({ path: "retried.bin" }) };
    });
    const { promise } = await startUpload({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      backoffMs: [1],
      chunkSize: 8,
      session: { uploadId: "session", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]] });
    await expect(promise).resolves.toMatchObject({ path: "retried.bin" });
    expect(completes).toBe(2);
  });

  it("rejects after the bounded number of incomplete passes", async () => {
    const retries: string[] = [];
    const { promise } = await startUpload({
      chunkSize: 8,
      session: { uploadId: "session", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      callbacks: {
        onRetry: (info: { code: string }) => retries.push(info.code),
      },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    for (let pass = 0; pass < 4; pass += 1) {
      await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(pass + 1));
      FakeXHR.all[pass]!.finish(200, { ranges: [] });
    }
    await expect(promise).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(retries.filter(code => code === "INCOMPLETE")).toHaveLength(4);
  });

  it("keeps the server ranges visible when an upload finally fails", async () => {
    const progress: number[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/status")) return { ok: false, status: 500 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ranges: [[0, 4]] }),
      };
    });
    const customClient = new UploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { promise } = await startUpload({
      client: customClient,
      maxAttempts: 1,
      callbacks: { onProgress: (value: number) => progress.push(value) },
    });
    FakeXHR.all[0]!.finish(403, { detail: "denied" });
    await expect(promise).rejects.toMatchObject({ status: 403 });
    await vi.waitFor(() => expect(progress).toContain(4));
  });

  it("does not restart a lost session when restart is disabled", async () => {
    const fetchImpl = vi.fn();
    const { promise } = await startUpload({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      restartOnSessionLoss: false,
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(404, { detail: "lost" });
    await expect(promise).rejects.toMatchObject({ code: "SESSION_LOST" });
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).includes("/init")),
    ).toBe(false);
  });

  it("replans queued windows after a 413", async () => {
    const { promise } = await startUpload({
      file: blobOf(12000),
      chunkSize: 12000,
      minChunkBytes: 1000,
      maxChunkBytes: 12000,
      concurrency: 1,
      session: {
        uploadId: "session",
        chunkSize: 4000,
        concurrency: 1,
        ranges: [],
        size: 12000,
      },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(413, "too large");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(6000);
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 6000]] });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 12000]] });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("replans every queued window after a smaller proxy limit", async () => {
    const { promise } = await startUpload({
      file: blobOf(16000),
      chunkSize: 4000,
      minChunkBytes: 100,
      maxChunkBytes: 4000,
      concurrency: 1,
      session: {
        uploadId: "session",
        chunkSize: 4000,
        concurrency: 1,
        ranges: [],
        size: 16000,
      },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(413, "too large");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    const offsets: string[] = [];
    for (let index = 1; index < 9; index += 1) {
      const xhr = FakeXHR.all[index];
      if (!xhr) {
        await vi.waitFor(() => expect(FakeXHR.all.length).toBeGreaterThan(index));
      }
      const current = FakeXHR.all[index]!;
      offsets.push(new URL(current.url, "http://x").searchParams.get("offset") ?? "");
      const offset = Number(offsets.at(-1));
      current.finish(200, {
        ranges: [[0, Math.min(16000, offset + (current.body?.size ?? 0))]],
      });
    }
    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(offsets).toContain("2000");
  });

  it("initializes a missing session and uses fallback chunk settings", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/init")) {
        return {
          ok: true,
          json: async () => ({
            upload_id: "created",
            chunk_size: 4,
            concurrency: 1,
            size: 8,
          }),
        };
      }
      return { ok: true, json: async () => ({ path: "" }) };
    });
    const { promise } = await startUpload({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      session: null,
      chunkSize: null,
      concurrency: null,
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]] });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]] });
    await expect(promise).resolves.toMatchObject({ path: "" });

    FakeXHR.all = [];
    const zeroHints = {
      initWithRetry: vi.fn().mockResolvedValue({
        upload_id: "zero",
        chunk_size: 0,
        concurrency: 0,
        size: 4,
      }),
      put: vi.fn().mockResolvedValue({ ranges: [[0, 4]] }),
      complete: vi.fn().mockResolvedValue({ path: "zero.bin" }),
      status: vi.fn(),
    };
    await expect(
      uploadFile({
        client: zeroHints,
        file: blobOf(4),
        destDir: "/",
      }),
    ).resolves.toMatchObject({ uploadId: "zero" });
  });

  it("falls back to the file name when finalize returns no path", async () => {
    const file = new File(["12345678"], "fallback.bin");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const promise = uploadFile({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      file,
      destDir: "/",
      session: {
        uploadId: "session",
        chunkSize: 8,
        concurrency: 1,
        ranges: [[0, 8]],
        size: 8,
      },
    });
    await expect(promise).resolves.toMatchObject({ path: "fallback.bin" });
  });

  it("handles a session without ranges and invalid chunk hints", async () => {
    const { promise } = await startUpload({
      chunkSize: -1,
      concurrency: 0,
      session: {
        uploadId: "session",
        chunkSize: 0,
        concurrency: 0,
        ranges: null,
        size: 8,
      },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(200, { received: 8 });
    await expect(promise).resolves.toMatchObject({ ok: true });

    const initClient = {
      initWithRetry: vi.fn().mockResolvedValue({
        upload_id: "new",
        chunk_size: 4,
        concurrency: 1,
        ranges: [[0, 0]],
        size: 4,
      }),
      put: vi.fn().mockResolvedValue({ ranges: [[0, 4]] }),
      complete: vi.fn().mockResolvedValue({ path: "new.bin" }),
      status: vi.fn(),
    };
    await expect(
      uploadFile({
        client: initClient,
        file: blobOf(4),
        destDir: "/",
      }),
    ).resolves.toMatchObject({ uploadId: "new" });

    FakeXHR.all = [];
    const receivedZero = await startUpload({
      client: {
        put: vi.fn().mockResolvedValue({ received: 0 }),
        complete: vi.fn().mockResolvedValue({ path: "zero.bin" }),
        status: vi.fn(),
      },
      chunkSize: 8,
      session: { uploadId: "session", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
    });
    await expect(receivedZero.promise).resolves.toMatchObject({ path: "zero.bin" });
  });

  it("rejects a 413 at the minimum chunk size", async () => {
    const { promise } = await startUpload({
      file: blobOf(100),
      chunkSize: 100,
      minChunkBytes: 100,
      maxChunkBytes: 100,
      session: {
        uploadId: "session",
        chunkSize: 100,
        concurrency: 1,
        ranges: [],
        size: 100,
      },
    });
    FakeXHR.all[0]!.finish(413, { message: "too large" });
    await expect(promise).rejects.toMatchObject({ status: 413 });
  });

  it("wraps a non-upload error from put", async () => {
    const rejectingClient = {
      put: vi.fn().mockRejectedValue("offline"),
      complete: vi.fn(),
      status: vi.fn().mockResolvedValue(null),
    };
    const promise = uploadFile({
      client: rejectingClient,
      file: blobOf(4),
      destDir: "/",
      maxAttempts: 1,
      session: {
        uploadId: "session",
        chunkSize: 4,
        concurrency: 1,
        ranges: [],
        size: 4,
      },
    });
    await expect(promise).rejects.toMatchObject({
      message: "Upload failed",
      retryable: true,
    });
  });

  it("wraps a non-upload error from complete", async () => {
    const rejectingClient = {
      put: vi.fn(),
      complete: vi.fn().mockRejectedValue("offline"),
      status: vi.fn().mockResolvedValue(null),
    };
    const promise = uploadFile({
      client: rejectingClient,
      file: blobOf(4),
      destDir: "/",
      maxAttempts: 1,
      session: {
        uploadId: "session",
        chunkSize: 4,
        concurrency: 1,
        ranges: [[0, 4]],
        size: 4,
      },
    });
    await expect(promise).rejects.toMatchObject({ message: "offline" });
  });

  it("wraps a non-upload error while replacing a lost session", async () => {
    const fetchImpl = vi.fn().mockRejectedValue("init offline");
    const { promise } = await startUpload({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(404, { detail: "lost" });
    await expect(promise).rejects.toMatchObject({ message: "Upload failed" });
  });
});

describe("request deadlines", () => {
  it("abandons a stalled request after the idle timeout and retries it", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeXHR.all[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeXHR.all).toHaveLength(2);

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("keeps a slow request alive while bytes keep moving", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);

    for (let step = 0; step < 5; step += 1) {
      await vi.advanceTimersByTimeAsync(900);
      FakeXHR.all[0]!.progress((step + 1) * 100, 400);
    }
    expect(FakeXHR.all[0]!.aborted).toBe(false);

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("waits out a DLP scan after the body is sent", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      responseTimeoutMs: 60_000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);
    FakeXHR.all[0]!.progress(400, 400);
    FakeXHR.all[0]!.bodySent();

    // Far longer than the idle timeout: the scan must not kill the request.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeXHR.all[0]!.aborted).toBe(false);
    expect(FakeXHR.all).toHaveLength(1);

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("abandons an unacknowledged response after the response timeout", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      responseTimeoutMs: 2000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);
    FakeXHR.all[0]!.bodySent();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeXHR.all[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("cancels during a retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { promise } = await startUpload({
      signal: controller.signal,
      backoffMs: [10_000],
      maxAttempts: 2,
    });
    FakeXHR.all[0]!.finish(500);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("cancels before a retry starts and removes an unneeded abort listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const preAbort = await startUpload({
      signal: controller.signal,
      backoffMs: [1000],
      maxAttempts: 2,
      callbacks: {
        onRetry: () => controller.abort(),
      },
    });
    preAbort.promise.catch(() => {});
    FakeXHR.all[0]!.finish(500);
    await vi.advanceTimersByTimeAsync(0);
    await expect(preAbort.promise).rejects.toMatchObject({ code: "ABORTED" });

    FakeXHR.all = [];
    const liveController = new AbortController();
    const onListener = vi.spyOn(
      liveController.signal,
      "removeEventListener",
    );
    const normal = await startUpload({
      signal: liveController.signal,
      backoffMs: [1000],
      chunkSize: 8,
      session: { uploadId: "session", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
    });
    FakeXHR.all.at(-1)!.finish(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(normal.promise).resolves.toMatchObject({ ok: true });
    expect(onListener).toHaveBeenCalled();
  });
});
