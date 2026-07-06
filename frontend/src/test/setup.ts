import { vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

// Mock localStorage and sessionStorage for zustand persist middleware
const mockStorage: Record<string, string> = {}
const storageMock = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { mockStorage[key] = value }),
  removeItem: vi.fn((key: string) => { delete mockStorage[key] }),
  clear: vi.fn(() => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]) }),
  key: vi.fn((index: number) => Object.keys(mockStorage)[index] ?? null),
  length: 0,
}

Object.defineProperty(window, 'localStorage', { value: storageMock, writable: true })
Object.defineProperty(window, 'sessionStorage', { value: storageMock, writable: true })

// Mock ResizeObserver for xterm.js
export const mockResizeObserverInstances: MockResizeObserver[] = []

class MockResizeObserver {
  private callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    mockResizeObserverInstances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  trigger() {
    this.callback([], this)
  }
}
Object.defineProperty(window, 'ResizeObserver', { value: MockResizeObserver, writable: true })

// Mock document.fonts.load for xterm.js initialization
Object.defineProperty(document, 'fonts', {
  value: {
    load: vi.fn().mockResolvedValue(undefined),
  },
  writable: true,
})

// Mock window.matchMedia for xterm.js
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
  writable: true,
})
