import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => vi.fn(() => ({ id: 'socket' })))

vi.mock('socket.io-client', () => ({ io }))

describe('getSocket', () => {
  beforeEach(() => {
    vi.resetModules()
    io.mockClear()
  })

  it('creates one credentialed reconnecting socket and returns it on later calls', async () => {
    const { getSocket } = await import('./useSocket')

    const first = getSocket()
    const second = getSocket()

    expect(io).toHaveBeenCalledOnce()
    expect(io).toHaveBeenCalledWith({
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    })
    expect(first).toBe(second)
  })
})
