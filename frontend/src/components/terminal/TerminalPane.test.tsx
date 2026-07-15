import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useTerminalStore } from '@/store/terminalStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { createMockSocket } from '@/test/mocks/socket'
import { mockTerminalInstances, clearMockTerminalInstances } from '@/test/mocks/xterm'
import { mockResizeObserverInstances } from '@/test/setup'
import TerminalPane from './TerminalPane'

function seedStores(tabId: string, status: 'connected' | 'disconnected') {
  useTerminalStore.setState({
    sessionId: 'test-session',
    tabs: [
      {
        id: tabId,
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'test',
        label: null,
        status,
        sessionKey: `test-session:${tabId}`,
      },
    ],
    activeTabId: tabId,
  })

  useSettingsStore.setState({
    scrollbackLines: 10000,
    fontSize: 14,
  })

  useBroadcastStore.setState({
    enabled: false,
    excludedTabIds: [],
  })
}

describe('TerminalPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMockTerminalInstances()
    mockResizeObserverInstances.length = 0
  })

  afterEach(() => {
    act(() => {
      useTerminalStore.setState({ sessionId: '', tabs: [], activeTabId: null })
      useBroadcastStore.setState({ enabled: false, excludedTabIds: [] })
    })
  })

  it('remains interactive when remounted with an already-connected tab (split-exit regression)', async () => {
    const tabId = 'tab-1'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    expect(term.textarea).toBeInTheDocument()

    act(() => {
      term.simulateData('hello')
    })

    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({
        session_id: 'test-session',
        tab_id: tabId,
        data: 'hello',
      })
    )
  })

  it('drops terminal probe replies instead of sending them to the shell', async () => {
    const tabId = 'tab-probe'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    socket.emit.mockClear()

    act(() => {
      term.simulateData('\x1b[?1;2c')
      term.simulateData('\x1b[24;80R')
      term.simulateData('\x1b]11;rgb:0000/0000/0000\x07')
    })

    expect(socket.emit).not.toHaveBeenCalledWith('ssh:input', expect.anything())
  })

  it('keeps restore probe replies quiet before re-enabling user input', async () => {
    const tabId = 'tab-restore'
    act(() => {
      seedStores(tabId, 'disconnected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    socket.emit.mockClear()

    act(() => {
      socket._trigger('session:restored', { tab_id: tabId, status: 'active' })
    })
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve))
    })

    act(() => {
      term.simulateData('\x1b[?1;2c')
      term.simulateData('too-soon')
    })
    expect(socket.emit).not.toHaveBeenCalledWith('ssh:input', expect.anything())

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 850))
    })
    act(() => {
      term.simulateData('ready')
    })

    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({
        session_id: 'test-session',
        tab_id: tabId,
        data: 'ready',
      })
    )
  })

  it('suppresses input when mounted with a disconnected tab', async () => {
    const tabId = 'tab-2'
    act(() => {
      seedStores(tabId, 'disconnected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    act(() => {
      term.simulateData('hello')
    })

    expect(socket.emit).not.toHaveBeenCalledWith(
      'ssh:input',
      expect.anything()
    )
  })

  it('reuses the same terminal instance on remount (split-exit buffer preservation)', async () => {
    const tabId = 'tab-3'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()

    function Wrapper({ show }: { show: boolean }) {
      return show ? (
        <TerminalPane
          tabId={tabId}
          isActive={true}
          focused={true}
          socket={socket as unknown as import('socket.io-client').Socket}
        />
      ) : null
    }

    const { rerender } = render(<Wrapper show={true} />)

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBe(1)
    })

    const firstTerm = mockTerminalInstances[0]

    act(() => {
      rerender(<Wrapper show={false} />)
      rerender(<Wrapper show={true} />)
    })

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBe(1)
    })

    expect(mockTerminalInstances[0]).toBe(firstTerm)
  })

  it('sends plain Ctrl+C without a selection as a terminal interrupt', async () => {
    const tabId = 'tab-4'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]

    expect(term.simulateKey({ key: 'c', ctrlKey: true })).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({
        session_id: 'test-session',
        tab_id: tabId,
        data: '\x03',
      })
    )
  })

  it('keeps normal-mode terminal keys out of browser input handling', async () => {
    const tabId = 'tab-vi-navigation'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    for (const key of ['h', 'j', 'k', 'l', 'w', 'b', '0', '$', 'Escape', 'ArrowUp', 'Tab', 'Enter']) {
      expect(term.simulateKey({ key })).toBe(true)
      expect(term.lastKeyEvent?.defaultPrevented).toBe(true)
    }
  })

  it('keeps Ctrl+C as copy when terminal text is selected', async () => {
    const tabId = 'tab-5'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    term.selection = true

    expect(term.simulateKey({ key: 'c', ctrlKey: true })).toBe(false)
    expect(socket.emit).not.toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({ data: '\x03' })
    )
    expect(term.simulateKey({ key: 'c', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(term.simulateKey({ key: 'c', metaKey: true })).toBe(false)
  })

  it('does not emit duplicate terminal resize events for the same fitted size', async () => {
    const tabId = 'tab-6'
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })

    try {
      act(() => {
        seedStores(tabId, 'connected')
      })

      const socket = createMockSocket()
      render(
        <TerminalPane
          tabId={tabId}
          isActive={true}
          focused={true}
          socket={socket as unknown as import('socket.io-client').Socket}
        />
      )

      await waitFor(() => {
        expect(mockTerminalInstances.length).toBeGreaterThan(0)
        expect(mockResizeObserverInstances.length).toBeGreaterThan(0)
      })

      socket.emit.mockClear()
      const term = mockTerminalInstances[mockTerminalInstances.length - 1]
      const observer = mockResizeObserverInstances[mockResizeObserverInstances.length - 1]

      await act(async () => {
        observer.trigger()
        observer.trigger()
        await new Promise(resolve => requestAnimationFrame(resolve))
      })

      expect(socket.emit).not.toHaveBeenCalledWith('terminal:resize', expect.anything())

      term.cols = 100

      await act(async () => {
        observer.trigger()
        observer.trigger()
        await new Promise(resolve => requestAnimationFrame(resolve))
      })

      expect(socket.emit).toHaveBeenCalledTimes(1)
      expect(socket.emit).toHaveBeenCalledWith('terminal:resize', {
        session_id: 'test-session',
        tab_id: tabId,
        cols: 100,
        rows: 24,
      })
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
      else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
    }
  })

  it('preserves scrollback by stripping clear-scrollback output after Ctrl+L', async () => {
    const tabId = 'tab-7'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]

    act(() => {
      term.simulateKey({ key: 'l', ctrlKey: true })
      socket._trigger('ssh:output', { tab_id: tabId, data: '\x1b[H\x1b[2J\x1b[3Jprompt$ ' })
    })

    expect(term.write).toHaveBeenCalledWith('\x1b[H\x1b[2Jprompt$ ')
  })

  it('allows clear-scrollback output when it was not triggered by Ctrl+L', async () => {
    const tabId = 'tab-8'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]

    act(() => {
      socket._trigger('ssh:output', { tab_id: tabId, data: '\x1b[H\x1b[2J\x1b[3Jprompt$ ' })
    })

    expect(term.write).toHaveBeenCalledWith('\x1b[H\x1b[2J\x1b[3Jprompt$ ')
  })
})
