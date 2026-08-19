import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampUploadProgress, SpeedTracker } from './useSFTP'

describe('SpeedTracker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes bytes/sec over a 5s sliding window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tracker = new SpeedTracker()

    tracker.sample(0)
    expect(tracker.speed()).toBe(0) // fewer than 2 samples yet

    vi.setSystemTime(1000)
    tracker.sample(10_000)
    expect(tracker.speed()).toBeCloseTo(10_000) // 10 KB in 1s

    vi.setSystemTime(2500)
    tracker.sample(20_000)
    expect(tracker.speed()).toBeCloseTo(8_000) // 20 KB in 2.5s

    // Advance past the 5s window: t=0 and t=1000 samples are evicted.
    vi.setSystemTime(7000)
    tracker.sample(35_000)
    // Remaining samples: t=2500 (20_000) and t=7000 (35_000) → 15 KB / 4.5s
    expect(tracker.speed()).toBeCloseTo(3_333.33, 0)
  })

  it('does not regress when a retried chunk reports a lower byte count', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tracker = new SpeedTracker()

    tracker.sample(10_000_000)
    vi.setSystemTime(1000)
    tracker.sample(10_000_000) // XHR loaded reset to 0 is never sampled; clamp guards it
    expect(tracker.speed()).toBe(0) // flat samples → no positive delta

    vi.setSystemTime(2000)
    tracker.sample(13_000_000)
    expect(tracker.speed()).toBeGreaterThan(0)
  })

  it('returns 0 after reset', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tracker = new SpeedTracker()
    tracker.sample(0)
    vi.setSystemTime(1000)
    tracker.sample(10_000)
    tracker.reset()
    expect(tracker.speed()).toBe(0)
  })
})

describe('upload progress clamping', () => {
  it('never decreases reported bytes across a retry sequence', () => {
    const fileSize = 100 * 1024 * 1024
    const offset = 0
    let lastReported = 0

    // First attempt: 5MB of the chunk reaches the wire.
    lastReported = clampUploadProgress(lastReported, offset, 5 * 1024 * 1024, fileSize)
    expect(lastReported).toBe(5 * 1024 * 1024)

    // Retry: a fresh XHR starts reporting from 0.
    lastReported = clampUploadProgress(lastReported, offset, 0, fileSize)
    expect(lastReported).toBe(5 * 1024 * 1024)

    // Retry in progress: 3MB sent — still must not go backwards.
    lastReported = clampUploadProgress(lastReported, offset, 3 * 1024 * 1024, fileSize)
    expect(lastReported).toBe(5 * 1024 * 1024)

    // Passing the previous high water mark is fine.
    lastReported = clampUploadProgress(lastReported, offset, 6 * 1024 * 1024, fileSize)
    expect(lastReported).toBe(6 * 1024 * 1024)
  })

  it('honors the chunk offset when reporting bytes', () => {
    const fileSize = 100 * 1024 * 1024
    const offset = 32 * 1024 * 1024
    expect(clampUploadProgress(0, offset, 8 * 1024 * 1024, fileSize)).toBe(40 * 1024 * 1024)
  })

  it('clamps to the file size', () => {
    expect(clampUploadProgress(0, 99 * 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024))
      .toBe(100 * 1024 * 1024)
  })
})
