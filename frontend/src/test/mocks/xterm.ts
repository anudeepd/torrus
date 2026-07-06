import { vi } from 'vitest'

export const mockTerminalInstances: MockTerminal[] = []

export class MockTerminal {
  cols = 80
  rows = 24
  textarea: HTMLTextAreaElement | null = null
  modes = { bracketedPasteMode: false }
  options: Record<string, unknown> = {}
  selection = false
  buffer = { active: { viewportY: 0, baseY: 0 } }
  scrollToBottom = vi.fn()
  private _dataHandler: ((data: string) => void) | null = null
  private _keyHandler: ((event: KeyboardEvent) => boolean) | null = null
  constructor() {
    this.textarea = document.createElement('textarea')
    mockTerminalInstances.push(this)
  }

  open(container: HTMLElement) {
    if (this.textarea) {
      container.appendChild(this.textarea)
    }
  }

  loadAddon() {}
  fit() {}
  focus() {}
  dispose() {}
  write = vi.fn()
  hasSelection() { return this.selection }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this._keyHandler = handler
  }
  attachCustomWheelEventHandler() {}

  onData(handler: (data: string) => void) {
    this._dataHandler = handler
    return { dispose: () => { this._dataHandler = null } }
  }

  simulateData(data: string) {
    if (this._dataHandler) {
      this._dataHandler(data)
    }
  }

  simulateKey(eventInit: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', eventInit)
    return this._keyHandler?.(event)
  }
}

export function clearMockTerminalInstances() {
  mockTerminalInstances.length = 0
}

export class MockFitAddon {
  fit() {}
}

export class MockWebLinksAddon {}

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: MockFitAddon,
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: MockWebLinksAddon,
}))
