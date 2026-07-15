import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAuthIdleTimer } from './authIdleTimer'

describe('startAuthIdleTimer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does nothing when LDAP idle timeout is disabled', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()

    startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 0, onIdle })
    vi.advanceTimersByTime(60_000)

    expect(onIdle).not.toHaveBeenCalled()
  })

  it('redirects after configured inactivity plus expiry grace', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()

    startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 2, onIdle })
    vi.advanceTimersByTime(2_999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('resets the idle deadline when activity occurs before expiry', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()

    startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 2, onIdle })
    vi.advanceTimersByTime(2_500)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }))
    vi.advanceTimersByTime(2_999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('expires instead of resetting when background timer delivery is delayed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const onIdle = vi.fn()

    startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 2, onIdle })

    vi.setSystemTime(3_001)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }))

    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('checks an overdue deadline as soon as the page regains focus', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const onIdle = vi.fn()

    startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 2, onIdle })

    vi.setSystemTime(3_001)
    window.dispatchEvent(new Event('focus'))

    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('removes activity listeners and pending timers on cleanup', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const cleanup = startAuthIdleTimer({ enabled: true, idleTimeoutSeconds: 2, onIdle })

    cleanup()
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(3_000)

    expect(onIdle).not.toHaveBeenCalled()
  })
})
