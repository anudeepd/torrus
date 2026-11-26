import { vi } from 'vitest'

export const mockTerminalInstances: MockTerminal[] = []
export const mockSearchAddonInstances: MockSearchAddon[] = []
export const mockWebLinkHandlers: Array<(event: MouseEvent, uri: string) => void> = []
export let mockFitDimensions: { cols: number; rows: number } | null = null
export let mockTerminalHasTextarea = true
export let mockTerminalConstructorError: Error | null = null
export let mockTerminalHasFallbackTextarea = true

export function setMockFitDimensions(dimensions: { cols: number; rows: number } | null) {
  mockFitDimensions = dimensions
}

export function setMockTerminalHasTextarea(value: boolean) {
  mockTerminalHasTextarea = value
}

export function setMockTerminalConstructorError(error: Error | null) {
  mockTerminalConstructorError = error
}

export function setMockTerminalHasFallbackTextarea(value: boolean) {
  mockTerminalHasFallbackTextarea = value
}

export class MockTerminal {
  cols = 80
  rows = 24
  textarea: HTMLTextAreaElement | null = null
  modes = { bracketedPasteMode: false }
  unicode = { activeVersion: '6' }
  options: Record<string, unknown> = {}
  lastKeyEvent: KeyboardEvent | null = null
  selection = false
  buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } }
  scrollToBottom = vi.fn()
  reset = vi.fn()
  private _dataHandler: ((data: string) => void) | null = null
  private _keyHandler: ((event: KeyboardEvent) => boolean) | null = null
  private _wheelHandler: ((event: WheelEvent) => boolean) | null = null
  constructor(options: Record<string, unknown> = {}) {
    if (mockTerminalConstructorError) throw mockTerminalConstructorError
    this.options = options
    this.textarea = mockTerminalHasTextarea ? document.createElement('textarea') : null
    mockTerminalInstances.push(this)
  }

  open(container: HTMLElement) {
    if (this.textarea) {
      container.appendChild(this.textarea)
    } else if (mockTerminalHasFallbackTextarea) {
      const fallback = document.createElement('textarea')
      fallback.dataset.fallback = 'true'
      container.appendChild(fallback)
    }
  }

  loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
    addon.activate?.(this)
  }
  fit() {}
  focus = vi.fn()
  dispose = vi.fn()
  write = vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.())
  hasSelection() { return this.selection }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this._keyHandler = handler
  }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this._wheelHandler = handler
  }

  simulateWheel() {
    return this._wheelHandler?.(new WheelEvent('wheel', { cancelable: true }))
  }

  onData(handler: (data: string) => void) {
    this._dataHandler = handler
    return { dispose: () => { this._dataHandler = null } }
  }

  simulateData(data: string) {
    if (this._dataHandler) {
      this._dataHandler(data)
    }
  }

  input(data: string) {
    this.simulateData(data)
  }

  simulateKey(eventInit: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...eventInit })
    this.lastKeyEvent = event
    return this._keyHandler?.(event)
  }
}

export function clearMockTerminalInstances() {
  mockTerminalInstances.length = 0
  mockSearchAddonInstances.length = 0
  mockWebLinkHandlers.length = 0
  mockFitDimensions = null
  mockTerminalHasTextarea = true
  mockTerminalConstructorError = null
  mockTerminalHasFallbackTextarea = true
}

export class MockFitAddon {
  private terminal: MockTerminal | null = null

  activate(terminal: MockTerminal) {
    this.terminal = terminal
  }

  fit() {
    if (!mockFitDimensions || !this.terminal) return
    this.terminal.cols = mockFitDimensions.cols
    this.terminal.rows = mockFitDimensions.rows
  }
}

export class MockWebLinksAddon {
  constructor(handler: (event: MouseEvent, uri: string) => void) {
    mockWebLinkHandlers.push(handler)
  }
}

export class MockUnicode11Addon {}

export class MockSearchAddon {
  findNext = vi.fn(() => true)
  findPrevious = vi.fn(() => true)
  clearDecorations = vi.fn()

  constructor() {
    mockSearchAddonInstances.push(this)
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: MockFitAddon,
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: MockWebLinksAddon,
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: MockSearchAddon,
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: MockUnicode11Addon,
}))
