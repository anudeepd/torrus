import { vi } from 'vitest'

export const mockTerminalInstances: MockTerminal[] = []

export class MockTerminal {
  cols = 80
  rows = 24
  textarea: HTMLTextAreaElement | null = null
  modes = { bracketedPasteMode: false }
  options: Record<string, unknown> = {}
  private _dataHandler: ((data: string) => void) | null = null
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
  write() {}
  hasSelection() { return false }
  attachCustomKeyEventHandler() {}
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
