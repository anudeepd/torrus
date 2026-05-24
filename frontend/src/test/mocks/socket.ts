import { vi } from 'vitest'

export function createMockSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  return {
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(handler)
      return undefined as unknown as typeof handler
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    // Helper to trigger listeners in tests
    _trigger(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach(handler => handler(...args))
    },
  }
}

export type MockSocket = ReturnType<typeof createMockSocket>
