import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Socket } from 'socket.io-client'
import { useTerminalStore } from '@/store/terminalStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { createMockSocket } from '@/test/mocks/socket'
import {
  mockSearchAddonInstances,
  mockTerminalInstances,
  mockWebLinkHandlers,
  clearMockTerminalInstances,
  setMockFitDimensions,
  setMockTerminalConstructorError,
  setMockTerminalHasFallbackTextarea,
  setMockTerminalHasTextarea,
} from '@/test/mocks/xterm'
import { mockResizeObserverInstances } from '@/test/setup'
import { streamPosition } from '@/lib/terminalStream'
import TerminalPane from './TerminalPane'
const originalUserAgent = navigator.userAgent

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: userAgent })
}

function seedStores(tabId: string, status: 'connected' | 'connecting' | 'disconnected') {
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
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
  })

  afterEach(() => {
    vi.useRealTimers()
    setUserAgent(originalUserAgent)
    act(() => {
      useTerminalStore.setState({ sessionId: '', tabs: [], activeTabId: null })
      useBroadcastStore.setState({ enabled: false, excludedTabIds: [] })
    })
  })

  it('enforces readable contrast for terminal ANSI colors', async () => {
    const tabId = 'tab-contrast'
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

    expect(mockTerminalInstances[mockTerminalInstances.length - 1]?.options).toEqual(
      expect.objectContaining({ minimumContrastRatio: 4.5 }),
    )
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

  it('forwards terminal probe replies to the process that asked for them', async () => {
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

    expect(socket.emit).toHaveBeenNthCalledWith(
      1,
      'ssh:input',
      expect.objectContaining({ data: '\x1b[?1;2c' }),
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      2,
      'ssh:input',
      expect.objectContaining({ data: '\x1b[24;80R' }),
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      3,
      'ssh:input',
      expect.objectContaining({ data: '\x1b]11;rgb:0000/0000/0000\x07' }),
    )
  })

  it('does not broadcast terminal probe replies to other terminals', async () => {
    const tabId = 'tab-probe-focused'
    act(() => {
      seedStores(tabId, 'connected')
      useTerminalStore.setState(state => ({
        tabs: [
          ...state.tabs,
          {
            id: 'tab-probe-other',
            type: 'terminal',
            host: 'localhost',
            port: 22,
            username: 'test',
            label: null,
            status: 'connected',
            sessionKey: 'test-session:tab-probe-other',
          },
        ],
      }))
      useBroadcastStore.setState({ enabled: true, excludedTabIds: [] })
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
      term.textarea?.dispatchEvent(new FocusEvent('focus'))
    })
    socket.emit.mockClear()

    act(() => {
      term.simulateData('\x1b[?1;2c')
    })

    expect(socket.emit).toHaveBeenCalledOnce()
    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({ tab_id: tabId, data: '\x1b[?1;2c' }),
    )
  })

  it('marks input after a password prompt as sensitive until Enter', async () => {
    const tabId = 'tab-sensitive-input'
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
      socket._trigger('ssh:output', { tab_id: tabId, data: 'Pass' })
      socket._trigger('ssh:output', { tab_id: tabId, data: 'word: ' })
      term.simulateData('secret')
      term.simulateData('\r')
      term.simulateData('ls')
    })

    expect(socket.emit).toHaveBeenNthCalledWith(
      1,
      'ssh:input',
      expect.objectContaining({ data: 'secret', sensitive: true }),
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      2,
      'ssh:input',
      expect.objectContaining({ data: '\r', sensitive: true }),
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      3,
      'ssh:input',
      expect.not.objectContaining({ sensitive: true }),
    )
  })

  describe('numbered output', () => {
    const encode = (text: string) => new TextEncoder().encode(text)
    const drawn = (term: (typeof mockTerminalInstances)[number]) =>
      term.write.mock.calls
        .map(([chunk]) => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)))
        .join('')

    async function renderConnected(tabId: string) {
      act(() => {
        seedStores(tabId, 'connected')
      })
      const socket = createMockSocket()
      render(
        <TerminalPane
          tabId={tabId}
          isActive={true}
          focused={true}
          socket={socket as unknown as Socket}
        />,
      )
      await waitFor(() => {
        expect(mockTerminalInstances.length).toBeGreaterThan(0)
      })
      return { socket, term: mockTerminalInstances[mockTerminalInstances.length - 1] }
    }

    it('clears the terminal before drawing a replay the server could not resume', async () => {
      const tabId = 'tab-reset'
      const { socket, term } = await renderConnected(tabId)

      act(() => {
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('old'), offset: 3, stream: 's1' })
        socket._trigger('ssh:output', {
          tab_id: tabId, data: encode('replay'), offset: 9000, stream: 's1', reset: true,
        })
      })

      const [oldDraw, replayDraw] = term.write.mock.invocationCallOrder
      expect(term.reset).toHaveBeenCalledTimes(1)
      expect(term.reset.mock.invocationCallOrder[0]).toBeGreaterThan(oldDraw)
      expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(replayDraw)
      expect(streamPosition(tabId)).toEqual({ stream: 's1', offset: 9000 })
    })

    it('draws each byte of the stream once however the chunks arrive', async () => {
      const tabId = 'tab-dedupe'
      const { socket, term } = await renderConnected(tabId)

      act(() => {
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('hello'), offset: 5, stream: 's1' })
        // The same chunk again, as when a re-registration is answered twice.
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('hello'), offset: 5, stream: 's1' })
        // A replay that starts inside what is already on screen.
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('lo world'), offset: 11, stream: 's1' })
      })

      expect(drawn(term)).toBe('hello world')
      expect(streamPosition(tabId)).toEqual({ stream: 's1', offset: 11 })
      expect(term.reset).not.toHaveBeenCalled()
    })

    it('does not mistake a new SSH session in the same tab for output it already drew', async () => {
      const tabId = 'tab-new-session'
      const { socket, term } = await renderConnected(tabId)

      act(() => {
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('first'), offset: 900, stream: 's1' })
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('second'), offset: 6, stream: 's2' })
      })

      expect(drawn(term)).toBe('firstsecond')
      expect(streamPosition(tabId)).toEqual({ stream: 's2', offset: 6 })
    })

    it('keeps a screen rebuilt from a replay at the bottom until the user scrolls', async () => {
      const tabId = 'tab-follow'
      const { socket, term } = await renderConnected(tabId)

      act(() => {
        socket._trigger('ssh:output', {
          tab_id: tabId, data: encode('rebuilt'), offset: 100, stream: 's1', reset: true,
        })
      })
      term.scrollToBottom.mockClear()

      // Rebuilding the screen collapsed and regrew the scroll area, leaving the
      // viewport behind while output continues.
      term.buffer.active.baseY = 500
      term.buffer.active.viewportY = 0
      act(() => {
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('more'), offset: 104, stream: 's1' })
      })
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1)

      // A wheel scroll means the user is reading history: leave the viewport alone.
      act(() => {
        term.simulateWheel()
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('more'), offset: 108, stream: 's1' })
      })
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1)
    })

    it('does not move the viewport for a terminal that never rebuilt its screen', async () => {
      const tabId = 'tab-nofollow'
      const { socket, term } = await renderConnected(tabId)

      term.buffer.active.baseY = 500
      term.buffer.active.viewportY = 0
      act(() => {
        socket._trigger('ssh:output', { tab_id: tabId, data: encode('live'), offset: 40, stream: 's1' })
      })

      expect(term.scrollToBottom).not.toHaveBeenCalled()
    })
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

  it('lays out the terminal before the connect form opens a PTY', async () => {
    const tabId = 'tab-connect-size'
    act(() => {
      seedStores(tabId, 'disconnected')
    })
    setMockFitDimensions({ cols: 123, rows: 45 })

    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        if (getComputedStyle(this).display === 'none') return null
        let parent = this.parentElement
        while (parent) {
          if (getComputedStyle(parent).display === 'none') return null
          parent = parent.parentElement
        }
        return document.body
      },
    })
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })

    try {
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
      expect(term.cols).toBe(123)
      expect(term.rows).toBe(45)
      expect(term.textarea?.parentElement?.parentElement?.style.display).not.toBe('none')

      socket.emit.mockClear()
      fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
      fireEvent.change(screen.getByTestId('port-input'), { target: { value: '22' } })
      fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
      fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:connect',
        expect.objectContaining({ host: 'example.com', cols: 123, rows: 45 }),
      )
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
      else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
      if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
      else delete (Element.prototype as { clientWidth?: unknown }).clientWidth
      if (clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', clientHeight)
      else delete (Element.prototype as { clientHeight?: unknown }).clientHeight
    }
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

  it('opens the terminal-history find bar with Ctrl+F', async () => {
    const tabId = 'tab-find'
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
      expect(term.simulateKey({ key: 'f', ctrlKey: true })).toBe(false)
    })
    expect(term.lastKeyEvent?.defaultPrevented).toBe(true)

    const input = await screen.findByRole('textbox', { name: 'Find in terminal' })
    fireEvent.change(input, { target: { value: 'deploy complete' } })
    expect(input).toHaveValue('deploy complete')
    expect(mockSearchAddonInstances[mockSearchAddonInstances.length - 1]?.findNext).toHaveBeenCalledWith('deploy complete', { incremental: true })
    expect(screen.getByRole('button', { name: 'Next match' })).toBeInTheDocument()
  })

  it('opens terminal find when Ctrl+F is captured before xterm receives focus', async () => {
    const tabId = 'tab-global-find'
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

    const handled = fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(handled).toBe(false)
    expect(await screen.findByRole('textbox', { name: 'Find in terminal' })).toBeInTheDocument()
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
      'ssh:interrupt',
      {
        session_id: 'test-session',
        tab_id: tabId,
      }
    )
  })

  it('claims Ctrl+L for terminal clear on every platform, blocking the browser address bar', async () => {
    const tabId = 'tab-browser-ctrl-l'
    act(() => {
      seedStores(tabId, 'connected')
    })

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    socket.emit.mockClear()
    for (const userAgent of [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
    ]) {
      setUserAgent(userAgent)
      expect(term.simulateKey({ key: 'l', ctrlKey: true })).toBe(false)
      // Address bar must not be touched: preventDefault is unconditional.
      expect(term.lastKeyEvent?.defaultPrevented).toBe(true)
      expect(term.scrollToBottom).toHaveBeenCalled()
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: '\x0c' }))
      term.scrollToBottom.mockClear()
      socket.emit.mockClear()
    }
  })

  it('leaves ordinary key events available to xterm input handling', async () => {
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
    for (const key of [' ', 'a', 'h', 'j', 'k', 'l', 'w', 'b', '0', '$', 'Escape', 'ArrowUp', 'Tab', 'Enter']) {
      expect(term.simulateKey({ key })).toBe(true)
      expect(term.lastKeyEvent?.defaultPrevented).toBe(false)
    }
  })

  it('forwards held printable key repeats without synthesizing a sticky key', async () => {
    const tabId = 'tab-held-vi-navigation'
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

    expect(term.simulateKey({ key: 'j' })).toBe(true)
    for (const key of ['h', 'j', 'k', 'l']) {
      expect(term.simulateKey({ key, repeat: true })).toBe(false)
      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:input',
        expect.objectContaining({ data: key })
      )
    }
    expect(socket.emit).toHaveBeenCalledTimes(4)
  })

  it('normalizes cross-platform delete-word and restore shortcuts', async () => {
    const tabId = 'tab-word-editing'
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

    expect(term.simulateKey({ key: 'Backspace', altKey: true })).toBe(false)
    expect(term.lastKeyEvent?.defaultPrevented).toBe(true)
    expect(term.simulateKey({ key: 'Backspace', ctrlKey: true })).toBe(false)
    expect(term.lastKeyEvent?.defaultPrevented).toBe(true)
    expect(term.simulateKey({ key: 'y', ctrlKey: true })).toBe(false)
    expect(term.lastKeyEvent?.defaultPrevented).toBe(true)

    expect(socket.emit).toHaveBeenNthCalledWith(
      1,
      'ssh:input',
      expect.objectContaining({ data: '\x1b\x7f' })
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      2,
      'ssh:input',
      expect.objectContaining({ data: '\x1b\x7f' })
    )
    expect(socket.emit).toHaveBeenNthCalledWith(
      3,
      'ssh:input',
      expect.objectContaining({ data: '\x19' })
    )
    expect(socket.emit).toHaveBeenCalledTimes(3)
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

  it('moves visible rows into scrollback before readline erases the viewport on Ctrl+L', async () => {
    const tabId = 'tab-readline-clear'
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
    term.buffer.active.cursorY = 5

    act(() => {
      term.simulateKey({ key: 'l', ctrlKey: true })
      socket._trigger('ssh:output', {
        tab_id: tabId,
        data: '\x1b[2;1H\x1b[J\x1b[H\x1b[Kprompt$ ',
      })
    })

    expect(term.lastKeyEvent?.defaultPrevented).toBe(true)
    expect(term.scrollToBottom).toHaveBeenCalledOnce()
    expect(term.write).toHaveBeenCalledWith(
      `\x1b[s\x1b[24;1H${'\x1bD'.repeat(6)}\x1b[u`,
      expect.any(Function),
    )
    expect(socket.emit).toHaveBeenCalledWith('ssh:input', {
      session_id: 'test-session',
      tab_id: tabId,
      data: '\x0c',
    })
    expect(term.write).toHaveBeenCalledWith('\x1b[2;1H\x1b[J\x1b[H\x1b[Kprompt$ ')
  })

  it('preserves scrollback when Ctrl+L clear output arrives after a delay', async () => {
    const tabId = 'tab-delayed-clear'
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
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      act(() => {
        term.simulateKey({ key: 'l', ctrlKey: true })
        now.mockReturnValue(2_001)
        socket._trigger('ssh:output', { tab_id: tabId, data: '\x1b[H\x1b[2J\x1b[3Jprompt$ ' })
      })

      expect(term.write).toHaveBeenCalledWith('\x1b[H\x1b[2Jprompt$ ')
    } finally {
      now.mockRestore()
    }
  })

  it('preserves scrollback when the Ctrl+L clear sequence is split across output chunks', async () => {
    const tabId = 'tab-split-clear'
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
      socket._trigger('ssh:output', { tab_id: tabId, data: '\x1b[H\x1b[2J\x1b[' })
      socket._trigger('ssh:output', { tab_id: tabId, data: '3Jprompt$ ' })
    })

    expect(term.write).toHaveBeenCalledWith('\x1b[H\x1b[2J')
    expect(term.write).toHaveBeenCalledWith('prompt$ ')
    expect(term.write).not.toHaveBeenCalledWith(expect.stringContaining('\x1b[3J'))
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

  it('marks a connecting terminal as connected when it receives remote output', async () => {
    const tabId = 'tab-output-confirms-connection'
    act(() => {
      seedStores(tabId, 'connecting')
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

    act(() => {
      socket._trigger('ssh:output', { tab_id: tabId, data: 'prompt$ ' })
    })

    expect(useTerminalStore.getState().tabs[0]?.status).toBe('connected')
  })

  it('clears stale auth errors and completes a retried connection', async () => {
    const tabId = 'tab-connect-retry'
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

    fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
    fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(useTerminalStore.getState().tabs[0]?.status).toBe('connecting')

    act(() => {
      socket._trigger('ssh:error', {
        tab_id: tabId,
        message: 'Authentication failed. Check username and password.',
      })
    })
    expect(await screen.findByText('Authentication failed. Check username and password.')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'correct' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(useTerminalStore.getState().tabs[0]?.status).toBe('connecting')
    expect(screen.queryByText('Authentication failed. Check username and password.')).not.toBeInTheDocument()

    act(() => {
      socket._trigger('ssh:connected', { tab_id: tabId })
    })
    expect(useTerminalStore.getState().tabs[0]?.status).toBe('connected')
  })

  describe('coverage edges', () => {
    async function renderConnected(tabId: string) {
      act(() => seedStores(tabId, 'connected'))
      const socket = createMockSocket()
      const view = render(
        <TerminalPane
          tabId={tabId}
          isActive={true}
          focused={true}
          socket={socket as unknown as Socket}
        />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      return { socket, term: mockTerminalInstances.at(-1)!, view }
    }

    it('maps every custom key path to the right terminal action', async () => {
      const tabId = 'keys'
      const { socket, term } = await renderConnected(tabId)
      const tabButton = document.createElement('button')
      tabButton.id = `torrus-tab-${tabId}`
      document.body.appendChild(tabButton)

      expect(term.simulateKey({ key: 'F6' })).toBe(false)
      expect(document.activeElement).toBe(tabButton)

      socket.emit.mockClear()
      expect(term.simulateKey({ key: 'Backspace', altKey: true })).toBe(false)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: '\x1b\x7f' }))

      socket.emit.mockClear()
      expect(term.simulateKey({ key: 'y', ctrlKey: true })).toBe(false)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: '\x19' }))

      socket.emit.mockClear()
      expect(term.simulateKey({ key: 'a', repeat: true })).toBe(false)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'a' }))

      for (const init of [
        { key: 'w', metaKey: true },
        { key: 't', metaKey: true },
        { key: ',', metaKey: true },
        { key: 'Tab', ctrlKey: true },
      ]) {
        expect(term.simulateKey(init)).toBe(false)
      }

      expect(term.simulateKey({ key: 'f', ctrlKey: true })).toBe(false)
      expect(await screen.findByRole('textbox', { name: 'Find in terminal' })).toBeInTheDocument()
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in terminal' }), { key: 'Escape' })

      term.selection = true
      expect(term.simulateKey({ key: 'c', ctrlKey: true })).toBe(false)
      expect(term.simulateKey({ key: 'c', metaKey: true })).toBe(false)
      expect(term.simulateKey({ key: 'v', metaKey: true })).toBe(false)

      socket.emit.mockClear()
      term.rows = 0
      expect(term.simulateKey({ key: 'l', ctrlKey: true })).toBe(false)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: '\x0c' }))

      term.rows = 24
      socket.emit.mockClear()
      expect(term.simulateKey({ key: 'l', ctrlKey: true })).toBe(false)
      expect(term.write).toHaveBeenCalled()
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: '\x0c' }))
      tabButton.remove()
    })

    it('pastes plain and bracketed text and ignores a paste with no data', async () => {
      const { socket, term } = await renderConnected('paste')
      const textarea = term.textarea!

      const paste = (text: string | null, bracketed = false) => {
        term.modes.bracketedPasteMode = bracketed
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
        Object.defineProperty(event, 'clipboardData', {
          value: text === null ? undefined : { getData: () => text },
        })
        textarea.dispatchEvent(event)
        return event
      }

      socket.emit.mockClear()
      const plain = paste('one\ntwo')
      expect(plain.defaultPrevented).toBe(true)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'one\rtwo' }))

      socket.emit.mockClear()
      paste('bracketed', true)
      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:input',
        expect.objectContaining({ data: '\x1b[200~bracketed\x1b[201~' }),
      )

      socket.emit.mockClear()
      paste(null)
      expect(socket.emit).not.toHaveBeenCalled()
    })

    it('reuses the cached terminal paste and data handlers on remount', async () => {
      const tabId = 'cached'
      act(() => seedStores(tabId, 'connected'))
      const socket = createMockSocket()
      const first = render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBe(1))
      const term = mockTerminalInstances[0]
      first.unmount()

      render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBe(1))

      socket.emit.mockClear()
      term.textarea?.dispatchEvent(new FocusEvent('focus'))
      term.textarea?.dispatchEvent(new FocusEvent('blur'))
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'cached' } })
      term.textarea?.dispatchEvent(event)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'cached' }))

      term.simulateData('typed')
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'typed' }))

      const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
      const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
      const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 })
      Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      try {
        socket.emit.mockClear()
        act(() => mockResizeObserverInstances.at(-1)?.trigger())
        await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
        expect(socket.emit).toHaveBeenCalledWith('terminal:resize', expect.anything())
      } finally {
        if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
        else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
        if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
        else delete (Element.prototype as { clientWidth?: unknown }).clientWidth
        if (clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', clientHeight)
        else delete (Element.prototype as { clientHeight?: unknown }).clientHeight
      }
    })

    it('keeps a terminal usable when the font probe fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fonts = document.fonts.load as unknown as ReturnType<typeof vi.fn>
      fonts.mockRejectedValueOnce(new Error('missing'))
      const { term } = await renderConnected('font-fail')
      expect(term).toBeDefined()
      expect(warn).toHaveBeenCalledWith(
        'Failed to preload JetBrains Mono font; terminal may use fallback',
      )
    })

    it('blocks script links and opens external links safely', async () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderConnected('links')
      const handler = mockWebLinkHandlers.at(-1)!

      for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox']) {
        const event = new MouseEvent('click', { cancelable: true })
        handler(event, uri)
        expect(event.defaultPrevented).toBe(true)
      }
      expect(open).not.toHaveBeenCalled()

      handler(new MouseEvent('click'), 'https://example.com')
      expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    })

    it('drives find results, keyboard shortcuts, escape handling, and close', async () => {
      await renderConnected('search')
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      const input = await screen.findByRole('textbox', { name: 'Find in terminal' })
      const addon = mockSearchAddonInstances.at(-1)!
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
      expect(document.activeElement).toBe(input)
      fireEvent.keyDown(input, { key: 'x' })

      fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
      fireEvent.change(input, { target: { value: 'x' } })
      expect(addon.findNext).toHaveBeenCalledWith('x', { incremental: true })
      expect(screen.queryByText('No match')).not.toBeInTheDocument()
      addon.findNext.mockReturnValueOnce(false)
      fireEvent.change(input, { target: { value: 'zzz' } })
      expect(screen.getByText('No match')).toBeInTheDocument()
      addon.findNext.mockImplementationOnce(() => undefined as unknown as boolean)
      fireEvent.change(input, { target: { value: 'yyy' } })
      expect(screen.getByText('No match')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
      expect(addon.findPrevious).toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
      expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).not.toBeInTheDocument()
      expect(addon.clearDecorations).toHaveBeenCalled()

      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.tabIndex = -1
      document.body.appendChild(dialog)
      dialog.focus()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.getByRole('textbox', { name: 'Find in terminal' })).toBeInTheDocument()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).not.toBeInTheDocument()
      dialog.remove()

      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      const reopened = await screen.findByRole('textbox', { name: 'Find in terminal' })
      fireEvent.keyDown(reopened, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).not.toBeInTheDocument()
    })

    it('applies settings changes to the live terminal and refits when visible', async () => {
      const { term } = await renderConnected('settings')
      act(() => useSettingsStore.setState({ scrollbackLines: 1234, fontSize: 18 }))
      expect(term.options.scrollback).toBe(1234)
      expect(term.options.fontSize).toBe(18)

      const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
      const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
      const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 })
      Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      try {
        act(() => useSettingsStore.setState({ fontSize: 19 }))
        expect(term.options.fontSize).toBe(19)
      } finally {
        if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
        else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
        if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
        else delete (Element.prototype as { clientWidth?: unknown }).clientWidth
        if (clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', clientHeight)
        else delete (Element.prototype as { clientHeight?: unknown }).clientHeight
      }
    })

    it('writes string, buffer, and reset output and rejects unknown payloads', async () => {
      const { socket, term } = await renderConnected('output-types')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      act(() => socket._trigger('ssh:output', { tab_id: 'output-types', data: 'plain' }))
      expect(term.write).toHaveBeenCalledWith('plain')

      term.write.mockClear()
      const buffer = new window.ArrayBuffer(6)
      new Uint8Array(buffer).set([98, 117, 102, 102, 101, 114])
      act(() => socket._trigger('ssh:output', { tab_id: 'output-types', data: buffer }))
      expect(term.write).toHaveBeenCalled()

      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'output-types', data: { nope: true } }))
      expect(term.write).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        'Received unexpected data type from ssh:output:',
        'object',
      )

      act(() => socket._trigger('ssh:output', { tab_id: 'output-types', data: 'reset', reset: true }))
      expect(term.reset).toHaveBeenCalled()
    })

    it('handles partial scrollback clears across frames', async () => {
      const { socket, term } = await renderConnected('partial-clear')
      socket.emit.mockClear()
      act(() => {
        term.simulateKey({ key: 'l', ctrlKey: true })
      })
      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'partial-clear', data: '\x1b[' }))
      act(() => socket._trigger('ssh:output', { tab_id: 'partial-clear', data: '3Jhello' }))
      expect(term.write).toHaveBeenCalledWith('hello')

      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'partial-clear', data: 'more' }))
      expect(term.write).toHaveBeenCalledWith('more')
    })

    it('covers restored, connected, error, closed, and cleanup event paths', async () => {
      const tabId = 'events'
      act(() => seedStores(tabId, 'disconnected'))
      const socket = createMockSocket()
      const view = render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      const term = mockTerminalInstances.at(-1)!

      act(() => socket._trigger('session:restored', { tab_id: 'other', status: 'active' }))
      act(() => socket._trigger('session:restored', { tab_id: tabId, status: 'closed' }))
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('disconnected')

      act(() => socket._trigger('session:restored', { tab_id: tabId, status: 'active' }))
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('connected')

      act(() => socket._trigger('ssh:connected', { tab_id: 'other' }))
      act(() => socket._trigger('ssh:connected', { tab_id: tabId }))
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('connected')

      act(() => socket._trigger('ssh:error', { tab_id: 'other', message: 'ignored' }))
      act(() => socket._trigger('ssh:error', { tab_id: tabId, message: 'boom' }))
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('dead')
      expect(screen.getByText('boom')).toBeInTheDocument()

      act(() => socket._trigger('ssh:closed', { tab_id: 'other', reason: 'ignored' }))
      term.write.mockClear()
      act(() => socket._trigger('ssh:closed', { tab_id: tabId, reason: 'bye' }))
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('[torrus: bye]'))

      view.unmount()
    })

    it('times out a connection that never answers', async () => {
      vi.useFakeTimers()
      const tabId = 'timeout'
      act(() => seedStores(tabId, 'disconnected'))
      const socket = createMockSocket()
      render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await act(async () => { await Promise.resolve() })

      fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
      fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
      fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('connecting')

      act(() => vi.advanceTimersByTime(25_000))
      expect(useTerminalStore.getState().tabs[0]?.status).toBe('dead')
      expect(screen.getByText(/Connection timed out/)).toBeInTheDocument()
    })

    it('disposes a terminal after unmount only when its tab was closed', async () => {
      vi.useFakeTimers()
      const tabId = 'dispose'
      act(() => seedStores(tabId, 'connected'))
      const socket = createMockSocket()
      const { unmount } = render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await act(async () => { await Promise.resolve() })
      const term = mockTerminalInstances.at(-1)!
      unmount()
      act(() => useTerminalStore.setState({ tabs: [], activeTabId: null }))
      act(() => vi.advanceTimersByTime(1))
      expect(term.dispose).toHaveBeenCalled()
    })

    it('broadcasts typed input and interrupts to the other focused panes', async () => {
      const tabId = 'broadcast'
      act(() => {
        seedStores(tabId, 'connected')
        useTerminalStore.setState(state => ({
          tabs: [
            ...state.tabs,
            {
              id: 'other',
              type: 'terminal',
              host: 'other',
              port: 22,
              username: 'alice',
              label: 'Other',
              status: 'connected',
              sessionKey: 'test-session:other',
            },
          ],
        }))
        useBroadcastStore.setState({ enabled: true, excludedTabIds: [] })
      })
      const socket = createMockSocket()
      render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      const term = mockTerminalInstances.at(-1)!
      term.textarea?.dispatchEvent(new FocusEvent('focus'))

      socket.emit.mockClear()
      act(() => term.simulateData('x'))
      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:input',
        expect.objectContaining({ tab_id: 'other', data: 'x' }),
      )
      expect(socket.emit).toHaveBeenLastCalledWith(
        'ssh:input',
        expect.objectContaining({ tab_id: tabId, data: 'x' }),
      )

      socket.emit.mockClear()
      act(() => term.simulateKey({ key: 'c', ctrlKey: true }))
      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:interrupt',
        expect.objectContaining({ tab_id: 'other' }),
      )
      expect(socket.emit).toHaveBeenLastCalledWith(
        'ssh:interrupt',
        expect.objectContaining({ tab_id: tabId }),
      )
    })

    it('writes a pending partial clear prefix before forwarding user input', async () => {
      const { socket, term } = await renderConnected('pending-prefix')
      term.write.mockClear()
      act(() => term.simulateKey({ key: 'l', ctrlKey: true }))
      act(() => socket._trigger('ssh:output', { tab_id: 'pending-prefix', data: '\x1b[' }))
      term.write.mockClear()
      socket.emit.mockClear()

      act(() => term.simulateData('x'))
      expect(term.write).toHaveBeenCalledWith('\x1b[')
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'x' }))
    })

    it('falls back to a textarea inside the terminal container', async () => {
      setMockTerminalHasTextarea(false)
      const { socket } = await renderConnected('fallback-textarea')
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-fallback="true"]')!
      expect(textarea).toBeInTheDocument()

      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'fallback' } })
      socket.emit.mockClear()
      textarea.dispatchEvent(event)
      expect(socket.emit).toHaveBeenCalledWith('ssh:input', expect.objectContaining({ data: 'fallback' }))
    })

    it('logs a terminal construction failure instead of throwing', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      setMockTerminalConstructorError(new Error('terminal failed'))
      act(() => seedStores('construct-failure', 'connected'))
      render(
        <TerminalPane
          tabId="construct-failure"
          isActive={true}
          focused={true}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      await waitFor(() =>
        expect(error).toHaveBeenCalledWith('Terminal initialization failed', expect.any(Error)),
      )
    })

    it('cancels a pending resize frame and ignores zero-sized fits', async () => {
      const { socket, view } = await renderConnected('resize-cancel')
      const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
      const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
      const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 })
      Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })
      const cancel = vi.spyOn(window, 'cancelAnimationFrame')
      try {
        setMockFitDimensions({ cols: 0, rows: 0 })
        socket.emit.mockClear()
        act(() => mockResizeObserverInstances.at(-1)?.trigger())
        await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
        expect(socket.emit).not.toHaveBeenCalledWith('terminal:resize', expect.anything())

        act(() => mockResizeObserverInstances.at(-1)?.trigger())
      } finally {
        setMockFitDimensions(null)
        if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
        else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
        if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
        else delete (Element.prototype as { clientWidth?: unknown }).clientWidth
        if (clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', clientHeight)
        else delete (Element.prototype as { clientHeight?: unknown }).clientHeight
      }
      view.unmount()
      expect(cancel).toHaveBeenCalled()
    })

    it('shows the host fallback while a tab is connecting', () => {
      useTerminalStore.setState({
        sessionId: 'test-session',
        tabs: [{
          id: 'connecting',
          type: 'terminal',
          host: null,
          port: null,
          username: null,
          label: null,
          status: 'connecting',
          sessionKey: 'test-session:connecting',
        }],
        activeTabId: 'connecting',
      })
      render(
        <TerminalPane
          tabId="connecting"
          isActive={true}
          focused={true}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      expect(screen.getByText('Connecting to host…')).toBeInTheDocument()
    })

    it('does not interrupt while input is suppressed or the tab is disconnected', async () => {
      const { socket, term } = await renderConnected('interrupt-guard')
      act(() => socket._trigger('disconnect'))
      socket.emit.mockClear()
      act(() => term.simulateKey({ key: 'c', ctrlKey: true }))
      expect(socket.emit).not.toHaveBeenCalledWith('ssh:interrupt', expect.anything())

      act(() => socket._trigger('session:restored', { tab_id: 'interrupt-guard', status: 'closed' }))
      act(() => useTerminalStore.setState(state => ({
        tabs: state.tabs.map(tab => ({ ...tab, status: 'disconnected' })),
      })))
      act(() => term.simulateData('allowed'))
      socket.emit.mockClear()
      act(() => term.simulateKey({ key: 'c', ctrlKey: true }))
      expect(socket.emit).not.toHaveBeenCalledWith('ssh:interrupt', expect.anything())
    })

    it('shows a generic closed message for a dead tab without an error', () => {
      useTerminalStore.setState({
        sessionId: 'test-session',
        tabs: [{
          id: 'dead',
          type: 'terminal',
          host: 'host',
          port: 22,
          username: 'alice',
          label: null,
          status: 'dead',
          sessionKey: 's:dead',
        }],
        activeTabId: 'dead',
      })
      render(
        <TerminalPane
          tabId="dead"
          isActive={true}
          focused={true}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      expect(screen.getByText('Connection closed.')).toBeInTheDocument()
    })

    it('handles cached pastes with no data and bracketed paste mode', async () => {
      const tabId = 'cached-paste'
      act(() => seedStores(tabId, 'connected'))
      const socket = createMockSocket()
      const first = render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBe(1))
      first.unmount()
      render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBe(1))
      const term = mockTerminalInstances[0]

      const empty = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(empty, 'clipboardData', { value: undefined })
      term.textarea?.dispatchEvent(empty)

      term.modes.bracketedPasteMode = true
      const bracketed = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(bracketed, 'clipboardData', { value: { getData: () => 'cached' } })
      socket.emit.mockClear()
      term.textarea?.dispatchEvent(bracketed)
      expect(socket.emit).toHaveBeenCalledWith(
        'ssh:input',
        expect.objectContaining({ data: '\x1b[200~cached\x1b[201~' }),
      )
    })

    it('ignores output for another tab and writes a complete non-clear frame', async () => {
      const { socket, term } = await renderConnected('output-guard')
      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'other', data: 'ignored' }))
      expect(term.write).not.toHaveBeenCalled()

      act(() => term.simulateKey({ key: 'l', ctrlKey: true }))
      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'output-guard', data: 'plain' }))
      expect(term.write).toHaveBeenCalledWith('plain')
    })

    it('does not focus a pane that is active but not focused', async () => {
      const tabId = 'unfocused'
      act(() => seedStores(tabId, 'connected'))
      render(
        <TerminalPane
          tabId={tabId}
          isActive={true}
          focused={false}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
      expect(mockTerminalInstances.at(-1)!.focus).not.toHaveBeenCalled()
    })

    it('does not report a timeout when the connection completed first', async () => {
      vi.useFakeTimers()
      act(() => seedStores('timeout-race', 'disconnected'))
      const socket = createMockSocket()
      render(
        <TerminalPane
          tabId="timeout-race"
          isActive={true}
          focused={true}
          socket={socket as unknown as Socket}
        />,
      )
      await act(async () => { await Promise.resolve() })
      fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
      fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
      fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      act(() => socket._trigger('ssh:connected', { tab_id: 'timeout-race' }))
      act(() => vi.advanceTimersByTime(25_000))
      expect(screen.queryByText(/Connection timed out/)).not.toBeInTheDocument()
    })

    it('continues without a textarea when xterm renders none', async () => {
      setMockTerminalHasTextarea(false)
      setMockTerminalHasFallbackTextarea(false)
      const { term } = await renderConnected('no-textarea')
      expect(term.textarea).toBeNull()
    })

    it('does not focus after a restored pane unmounts before its frame', async () => {
      const tabId = 'restore-unmount'
      act(() => seedStores(tabId, 'disconnected'))
      const socket = createMockSocket()
      const view = render(
        <TerminalPane tabId={tabId} isActive={true} focused={true} socket={socket as unknown as Socket} />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      act(() => socket._trigger('session:restored', { tab_id: tabId, status: 'active' }))
      view.unmount()
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    })

    it('cancels terminal initialization when unmounted before the font probe resolves', async () => {
      let resolveFont: (() => void) | undefined
      const fonts = document.fonts.load as unknown as ReturnType<typeof vi.fn>
      fonts.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFont = resolve }))
      act(() => seedStores('font-pending', 'connected'))
      const view = render(
        <TerminalPane
          tabId="font-pending"
          isActive={true}
          focused={true}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      view.unmount()
      resolveFont?.()
      await act(async () => { await Promise.resolve() })
      expect(mockTerminalInstances).toHaveLength(0)
    })

    it('passes through a pending prefix that never became a clear sequence', async () => {
      const { socket, term } = await renderConnected('prefix-no-clear')
      act(() => term.simulateKey({ key: 'l', ctrlKey: true }))
      term.write.mockClear()
      act(() => socket._trigger('ssh:output', { tab_id: 'prefix-no-clear', data: '\x1b' }))
      act(() => socket._trigger('ssh:output', { tab_id: 'prefix-no-clear', data: 'x' }))
      expect(term.write).toHaveBeenCalledWith('\x1bx')
    })

    it('focuses active panes when the focused prop is omitted', async () => {
      const tabId = 'focus-default'
      act(() => seedStores(tabId, 'connected'))
      render(
        <TerminalPane
          tabId={tabId}
          isActive={true}
          socket={createMockSocket() as unknown as Socket}
        />,
      )
      await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0))
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
      expect(mockTerminalInstances.at(-1)!.focus).toHaveBeenCalled()
    })

    it('skips the timeout error when the tab left the connecting state without clearing it', async () => {
      vi.useFakeTimers()
      act(() => seedStores('timeout-skip', 'disconnected'))
      const socket = createMockSocket()
      render(
        <TerminalPane
          tabId="timeout-skip"
          isActive={true}
          focused={true}
          socket={socket as unknown as Socket}
        />,
      )
      await act(async () => { await Promise.resolve() })
      fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
      fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
      fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      act(() => useTerminalStore.setState(state => ({
        tabs: state.tabs.map(tab => ({ ...tab, status: 'connected' })),
      })))
      act(() => vi.advanceTimersByTime(25_000))
      expect(screen.queryByText(/Connection timed out/)).not.toBeInTheDocument()
    })

  })
})
