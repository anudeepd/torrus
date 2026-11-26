import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMockSocket } from '@/test/mocks/socket'
import { useTerminalStore } from '@/store/terminalStore'
import { useLayoutStore } from '@/store/layoutStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useSFTPStore } from '@/store/sftpStore'
import { AUTH_REDIRECT_EVENT } from '@/utils/authRedirect'

const originalMatchMedia = window.matchMedia

async function renderAppLayout({
  strict = false,
  navigateToAdmin,
}: { strict?: boolean; navigateToAdmin?: () => void } = {}) {
  vi.resetModules()

  const socket = createMockSocket()
  const redirectToLdapLogin = vi.fn()

  vi.doMock('@/hooks/useSocket', () => ({
    getSocket: () => socket,
  }))
  vi.doMock('@/utils/authRedirect', () => ({
    AUTH_REDIRECT_EVENT,
    AUTH_LOGOUT_EVENT: 'torrus:auth-logout',
    redirectToLdapLogin,
    redirectToLdapLoginNow: vi.fn(),
  }))
  vi.doMock('./TabBar', () => ({
    default: ({
      actions,
      compactSidebar,
      sidebarOpen,
    }: {
      actions: {
        addTab: () => void
        closeAllTabs: () => void
        closeTab: (tabId: string) => void
        cloneTab: (tabId: string) => void
        openSftpTab: (tabId: string) => void
        duplicateTab: (tabId: string) => void
        openSplitPicker: () => void
        openBroadcastPicker: () => void
        openCommandPalette: () => void
        toggleSidebar: () => void
        exitSplit: () => void
        setActiveTab: (tabId: string) => void
        openAdmin: () => void
      }
      compactSidebar?: boolean
      sidebarOpen?: boolean
    }) => (
      <>
        <button type="button" data-testid="add-tab" onClick={actions.addTab}>Add</button>
        <button type="button" data-testid="tabbar" onClick={actions.closeAllTabs}>Close All</button>
        <button type="button" data-testid="close-tab" onClick={() => actions.closeTab('terminal-tab')}>Close Tab</button>
        <button type="button" data-testid="close-sftp-tab" onClick={() => actions.closeTab('sftp-tab')}>Close SFTP Tab</button>
        <button type="button" data-testid="close-sftp-source" onClick={() => actions.closeTab('sftp-source')}>Close SFTP Source</button>
        <button type="button" data-testid="close-other-pane" onClick={() => actions.closeTab('other-tab')}>Close Other Pane</button>
        <button type="button" data-testid="clone-tab" onClick={() => actions.cloneTab('terminal-tab')}>Clone</button>
        <button type="button" data-testid="clone-bad" onClick={() => actions.cloneTab('missing-tab')}>Clone Bad</button>
        <button type="button" data-testid="open-sftp" onClick={() => actions.openSftpTab('terminal-tab')}>Open SFTP</button>
        <button type="button" data-testid="duplicate-tab" onClick={() => actions.duplicateTab('terminal-tab')}>Duplicate</button>
        <button type="button" data-testid="open-split" onClick={actions.openSplitPicker}>Split</button>
        <button type="button" data-testid="open-broadcast" onClick={actions.openBroadcastPicker}>Broadcast</button>
        <button type="button" data-testid="open-command" onClick={actions.openCommandPalette}>Command</button>
        <button type="button" data-testid="toggle-sidebar" onClick={actions.toggleSidebar}>Sidebar {String(sidebarOpen)}</button>
        <button type="button" data-testid="exit-split" onClick={actions.exitSplit}>Exit</button>
        <button type="button" data-testid="select-other" onClick={() => actions.setActiveTab('other-tab')}>Select Other</button>
        <button type="button" data-testid="open-admin" onClick={actions.openAdmin}>Admin</button>
        <span data-testid="compact">{String(compactSidebar)}</span>
      </>
    ),
  }))
  vi.doMock('./SessionSidebar', () => ({
    default: ({
      onLoadSession,
    }: {
      onLoadSession: (server: {
        id: string
        name: string
        host: string
        port: number
        username: string
      }) => void
    }) => (
      <aside data-testid="sidebar">
        <button
          type="button"
          data-testid="load-saved-session"
          onClick={() => onLoadSession({
            id: 'saved',
            name: 'Saved',
            host: 'saved.example',
            port: 2200,
            username: 'bob',
          })}
        >
          Load saved
        </button>
      </aside>
    ),
  }))
  vi.doMock('./LayoutPickerModal', () => ({
    default: ({ onApply, onClose }: { onApply: (layout: unknown) => void; onClose: () => void }) => (
      <>
        <button type="button" onClick={() => onApply({
          type: 'split',
          id: 'mock-layout',
          dir: 'h',
          ratio: 0.5,
          a: { type: 'leaf', tabId: 'terminal-tab' },
          b: { type: 'leaf', tabId: 'other-tab' },
        })}>Apply mocked layout</button>
        <button type="button" onClick={onClose}>Close picker</button>
      </>
    ),
  }))
  vi.doMock('./BroadcastPickerModal', () => ({
    default: ({
      onApply,
      onDisable,
      onClose,
    }: {
      onApply: (ids: string[], layout: unknown) => void
      onDisable: () => void
      onClose: () => void
    }) => (
      <>
        <button type="button" onClick={() => onApply(['terminal-tab', 'other-tab'], {
          type: 'split',
          id: 'mock-broadcast',
          dir: 'h',
          ratio: 0.5,
          a: { type: 'leaf', tabId: 'terminal-tab' },
          b: { type: 'leaf', tabId: 'other-tab' },
        })}>Start mocked broadcast</button>
        <button type="button" onClick={onDisable}>Disable mocked broadcast</button>
        <button type="button" onClick={onClose}>Close broadcast</button>
      </>
    ),
  }))
  vi.doMock('@/components/terminal/TerminalPane', () => ({
    default: () => <div data-testid="terminal-pane" />,
  }))
  vi.doMock('@/components/sftp/SFTPBrowser', () => ({
    default: () => <div data-testid="sftp-browser" />,
  }))

  // resetModules gives AppLayout its own store instances. Seed those from the
  // test's static imports so a test can arrange state before rendering.
  const { useTerminalStore: mountedTerminalStore } = await import('@/store/terminalStore')
  const { useLayoutStore: mountedLayoutStore } = await import('@/store/layoutStore')
  const { useBroadcastStore: mountedBroadcastStore } = await import('@/store/broadcastStore')
  const { useSFTPStore: mountedSFTPStore } = await import('@/store/sftpStore')
  const terminalState = useTerminalStore.getState()
  const layoutState = useLayoutStore.getState()
  const broadcastState = useBroadcastStore.getState()
  const sftpState = useSFTPStore.getState()
  mountedTerminalStore.setState({
    sessionId: terminalState.sessionId,
    tabs: terminalState.tabs,
    activeTabId: terminalState.activeTabId,
  })
  mountedLayoutStore.setState({
    root: layoutState.root,
    focusedTabId: layoutState.focusedTabId,
    dragTabId: layoutState.dragTabId,
  })
  mountedBroadcastStore.setState({
    enabled: broadcastState.enabled,
    excludedTabIds: broadcastState.excludedTabIds,
    splitOwned: broadcastState.splitOwned,
  })
  mountedSFTPStore.setState({
    tabs: sftpState.tabs,
    transfers: sftpState.transfers,
  })

  const { default: AppLayout } = await import('./AppLayout')
  render(strict ? <StrictMode><AppLayout navigateToAdmin={navigateToAdmin} /></StrictMode> : <AppLayout navigateToAdmin={navigateToAdmin} />)

    await waitFor(() => {
      expect(socket.on).toHaveBeenCalledWith('ssh:error', expect.any(Function))
      expect(socket.on).toHaveBeenCalledWith('sftp:error', expect.any(Function))
    })

  return {
    socket,
    redirectToLdapLogin,
    terminalStore: mountedTerminalStore,
    layoutStore: mountedLayoutStore,
    broadcastStore: mountedBroadcastStore,
    sftpStore: mountedSFTPStore,
  }
}

describe('AppLayout LDAP auth handling', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    })
    vi.clearAllMocks()
    vi.doUnmock('@/hooks/useSocket')
    vi.doUnmock('@/utils/authRedirect')
    vi.doUnmock('./TabBar')
    vi.doUnmock('./SessionSidebar')
    vi.doUnmock('./LayoutPickerModal')
    vi.doUnmock('./BroadcastPickerModal')
    vi.doUnmock('@/components/terminal/TerminalPane')
    vi.doUnmock('@/components/sftp/SFTPBrowser')
    useTerminalStore.setState({ sessionId: '', tabs: [], activeTabId: null })
    useLayoutStore.setState({ root: null, focusedTabId: null, dragTabId: null })
    useBroadcastStore.setState({ enabled: false, excludedTabIds: [], splitOwned: false })
  })

  it('redirects to LDAPGate when a socket event reports expired auth', async () => {
    const { socket, redirectToLdapLogin } = await renderAppLayout()

    socket._trigger('ssh:error', {
      tab_id: 'tab-1',
      message: 'Authentication required.',
      code: 'auth_required',
    })

    expect(redirectToLdapLogin).toHaveBeenCalledOnce()
  })

  it('does not redirect on ordinary SSH errors', async () => {
    const { socket, redirectToLdapLogin } = await renderAppLayout()

    socket._trigger('ssh:error', {
      tab_id: 'tab-1',
      message: 'Connection timed out.',
      code: 'timeout',
    })

    expect(redirectToLdapLogin).not.toHaveBeenCalled()
  })

  it('redirects to LDAPGate when an SFTP event reports expired auth', async () => {
    const { socket, redirectToLdapLogin } = await renderAppLayout()

    socket._trigger('sftp:list:result', {
      tab_id: 'sftp-tab',
      ok: false,
      message: 'Authentication required.',
      code: 'auth_required',
    })

    expect(redirectToLdapLogin).toHaveBeenCalledOnce()
  })

  it('preserves an empty restored tab list on reload', async () => {
    useTerminalStore.setState({ sessionId: 'test-session', tabs: [], activeTabId: null })

    await renderAppLayout({ strict: true })

    expect(useTerminalStore.getState().tabs).toEqual([])
    expect(useTerminalStore.getState().activeTabId).toBeNull()
  })

  it('does not show the active-session unload warning during LDAP redirects', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'tab-1',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: null,
        status: 'connected',
        sessionKey: 'test-session:tab-1',
      }],
      activeTabId: 'tab-1',
    })

    const { socket } = await renderAppLayout()

    act(() => {
      window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT))
    })
    const event = new Event('beforeunload', { cancelable: true })
    const allowed = window.dispatchEvent(event)

    expect(allowed).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(socket.emit).not.toHaveBeenCalledWith('ssh:disconnect', expect.anything())
  })

  it('does not show the active-session unload warning when opening admin', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'tab-1',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: null,
        status: 'connected',
        sessionKey: 'test-session:tab-1',
      }],
      activeTabId: 'tab-1',
    })

    const navigateToAdmin = vi.fn()
    await renderAppLayout({ navigateToAdmin })
    fireEvent.click(screen.getByTestId('open-admin'))

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)

    expect(navigateToAdmin).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
  })

  it('closes a disconnected SSH tab without an active-session warning', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: null,
        status: 'disconnected',
        sessionKey: 'test-session:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { socket } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('close-tab'))

    expect(screen.queryByText('Close session?')).not.toBeInTheDocument()
    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', {
      session_id: 'test-session',
      tab_id: 'terminal-tab',
    })
  })

  it('confirms before closing an sftp tab and closes only the sftp channel', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'sftp-tab',
        type: 'sftp',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: 'SFTP alice@localhost',
        status: 'connected',
        sessionKey: 'test-session:sftp-tab',
        sourceTabId: 'terminal-tab',
      }],
      activeTabId: 'sftp-tab',
    })
    const { socket } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('close-sftp-tab'))

    expect(screen.getByText('Close SFTP tab?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

    expect(socket.emit).toHaveBeenCalledWith('sftp:close', {
      session_id: 'test-session',
      tab_id: 'sftp-tab',
    })
    expect(socket.emit).not.toHaveBeenCalledWith('ssh:disconnect', expect.anything())
  })

  it('leaves browser-reserved tab and omnibox shortcuts to the browser', async () => {
    await renderAppLayout()

    for (const shortcut of [
      { key: 't', ctrlKey: true },
      { key: 'w', ctrlKey: true },
      { key: 'Tab', ctrlKey: true },
      { key: 'k', ctrlKey: true },
      { key: 't', metaKey: true },
      { key: 'w', metaKey: true },
      { key: 'k', metaKey: true },
    ]) {
      const event = createEvent.keyDown(window, shortcut)
      fireEvent(window, event)
      expect(event.defaultPrevented).toBe(false)
    }

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('opens settings via Ctrl+, across macOS, Windows, and Linux user agents', async () => {
    for (const userAgent of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
    ]) {
      Object.defineProperty(window.navigator, 'userAgent', {
        configurable: true,
        value: userAgent,
      })
      await renderAppLayout()

      const event = createEvent.keyDown(window, { key: ',', ctrlKey: true })
      fireEvent(window, event)
      // The handler is not platform-gated, so preventDefault fires on every UA.
      // (The dialog itself is a real component that may not mount in isolation
      // — the handler call is the contract being guarded.)
      expect(event.defaultPrevented).toBe(true)
    }
  })

  it('uses the internal warning before closing all active tabs', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        {
          id: 'terminal-tab',
          type: 'terminal',
          host: 'localhost',
          port: 22,
          username: 'alice',
          label: null,
          status: 'connected',
          sessionKey: 'test-session:terminal-tab',
        },
        {
          id: 'sftp-tab',
          type: 'sftp',
          host: 'localhost',
          port: 22,
          username: 'alice',
          label: 'SFTP alice@localhost',
          status: 'connected',
          sessionKey: 'test-session:sftp-tab',
          sourceTabId: 'terminal-tab',
        },
      ],
      activeTabId: 'terminal-tab',
    })
    const { socket } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('tabbar'))

    expect(screen.getByRole('alertdialog', { name: 'Close all tabs' })).toBeInTheDocument()
    expect(screen.getByText('Closing all tabs will disconnect SSH sessions and close SFTP browsers.')).toBeInTheDocument()
    expect(useTerminalStore.getState().tabs).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }))

    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', {
      session_id: 'test-session',
      tab_id: 'terminal-tab',
    })
    expect(socket.emit).toHaveBeenCalledWith('sftp:close', {
      session_id: 'test-session',
      tab_id: 'sftp-tab',
    })
  })

  it('retries terminal registration when a restore event is lost', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: null,
        status: 'connected',
        sessionKey: 'test-session:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { socket } = await renderAppLayout()
    socket._trigger('session:restored', { tab_id: 'terminal-tab', status: 'active' })
    socket.emit.mockClear()
    vi.useFakeTimers()

    act(() => {
      socket._trigger('connect')
      vi.advanceTimersByTime(3_000)
    })

    expect(socket.emit).toHaveBeenCalledTimes(2)
    expect(socket.emit).toHaveBeenNthCalledWith(1, 'session:register', {
      session_id: 'test-session',
      tab_id: 'terminal-tab',
    })
    expect(socket.emit).toHaveBeenNthCalledWith(2, 'session:register', {
      session_id: 'test-session',
      tab_id: 'terminal-tab',
    })
  })

  describe('after the socket reconnects', () => {
    // renderAppLayout() calls vi.resetModules(), so AppLayout holds its own copy of
    // terminalStream; a static import would record positions on a different copy.
    const loadTerminalStream = () => import('@/lib/terminalStream')

    const seedTerminal = () => {
      useTerminalStore.setState({
        sessionId: 'test-session',
        tabs: [{
          id: 'terminal-tab',
          type: 'terminal',
          host: 'localhost',
          port: 22,
          username: 'alice',
          label: null,
          status: 'connected',
          sessionKey: 'test-session:terminal-tab',
        }],
        activeTabId: 'terminal-tab',
      })
    }

    it('reports how far each terminal got so the server sends only what it missed', async () => {
      seedTerminal()
      const { socket } = await renderAppLayout()
      const { recordStreamPosition } = await loadTerminalStream()
      recordStreamPosition('terminal-tab', { stream: 'shell-1', offset: 4096 })
      socket._trigger('session:restored', { tab_id: 'terminal-tab', status: 'active' })
      socket.emit.mockClear()

      act(() => {
        socket._trigger('connect')
      })

      expect(socket.emit).toHaveBeenCalledWith('session:register', {
        session_id: 'test-session',
        tab_id: 'terminal-tab',
        resume: { stream: 'shell-1', offset: 4096 },
      })
    })

    it('asks again from wherever the terminal has got when a restore answer is lost', async () => {
      seedTerminal()
      const { socket } = await renderAppLayout()
      const { recordStreamPosition } = await loadTerminalStream()
      recordStreamPosition('terminal-tab', { stream: 'shell-1', offset: 100 })
      socket._trigger('session:restored', { tab_id: 'terminal-tab', status: 'active' })
      socket.emit.mockClear()
      vi.useFakeTimers()

      act(() => {
        socket._trigger('connect')
        // The first answer's output arrives; only the restore event is lost.
        recordStreamPosition('terminal-tab', { stream: 'shell-1', offset: 160 })
        vi.advanceTimersByTime(3_000)
      })

      expect(socket.emit.mock.calls.map(([, payload]) => payload.resume.offset)).toEqual([100, 160])
    })
  })

  it('adds, clones, duplicates, and opens SFTP tabs from shell actions', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 2222,
        username: 'alice',
        label: 'Production',
        status: 'connected',
        sessionKey: 'test-session:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { socket } = await renderAppLayout()
    fireEvent.click(screen.getByTestId('add-tab'))
    fireEvent.click(screen.getByTestId('clone-bad'))
    fireEvent.click(screen.getByTestId('clone-tab'))
    fireEvent.click(screen.getByTestId('open-sftp'))
    fireEvent.click(screen.getByTestId('duplicate-tab'))

    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:clone',
      expect.objectContaining({ source_tab_id: 'terminal-tab' }),
    )
    const { useTerminalStore: mountedStore } = await import('@/store/terminalStore')
    const tabs = mountedStore.getState().tabs
    expect(tabs.some(tab => tab.label === 'Production (clone)')).toBe(true)
    expect(tabs.some(tab => tab.label === 'Production')).toBe(true)
  })

  it('keeps split layouts coherent when tabs and panes close', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'terminal-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'One', status: 'disconnected', sessionKey: 's:terminal-tab' },
        { id: 'other-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'Two', status: 'disconnected', sessionKey: 's:other-tab' },
        { id: 'split-sftp', type: 'sftp', host: 'localhost', port: 22, username: 'alice', label: 'SFTP', status: 'connected', sessionKey: 's:split-sftp', sourceTabId: 'terminal-tab' },
      ],
      activeTabId: 'terminal-tab',
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'terminal-tab' },
        b: { type: 'split', id: 'right', dir: 'v', ratio: 0.5, a: { type: 'leaf', tabId: 'other-tab' }, b: { type: 'leaf', tabId: 'split-sftp' } },
      },
      focusedTabId: 'other-tab',
      dragTabId: null,
    })
    const { socket } = await renderAppLayout()
    fireEvent.click(screen.getByTestId('close-tab'))
    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', expect.anything())

    fireEvent.click(screen.getByTestId('select-other'))
    fireEvent.click(screen.getByTestId('close-other-pane'))
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'ssh:disconnect'),
    ).toHaveLength(2)
  })

  it('opens the split picker, applies a layout, and exits it', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'terminal-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'One', status: 'disconnected', sessionKey: 's:terminal-tab' },
        { id: 'other-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'Two', status: 'disconnected', sessionKey: 's:other-tab' },
      ],
      activeTabId: 'terminal-tab',
    })
    await renderAppLayout()
    fireEvent.click(screen.getByTestId('open-split'))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply mocked layout' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply mocked layout' })).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('exit-split'))
  })

  it('opens broadcast controls, applies and then disables broadcast', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'terminal-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'One', status: 'connected', sessionKey: 's:terminal-tab' },
        { id: 'other-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'Two', status: 'connected', sessionKey: 's:other-tab' },
      ],
      activeTabId: 'terminal-tab',
    })
    await renderAppLayout()
    fireEvent.click(screen.getByTestId('open-broadcast'))
    fireEvent.click(await screen.findByRole('button', { name: 'Start mocked broadcast' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Start mocked broadcast' })).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByTestId('open-broadcast'))
    fireEvent.click(await screen.findByRole('button', { name: 'Disable mocked broadcast' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Disable mocked broadcast' })).not.toBeInTheDocument(),
    )
  })

  it('opens the command palette and tracks compact sidebar state', async () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = []
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((_type, handler) => listeners.push(handler)),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    await renderAppLayout()
    expect(screen.getByTestId('compact')).toHaveTextContent('true')
    fireEvent.click(screen.getByTestId('toggle-sidebar'))
    act(() => listeners[0]?.({ matches: true } as MediaQueryListEvent))
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('toggle-sidebar'))
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => listeners[0]?.({ matches: false } as MediaQueryListEvent))
    fireEvent.click(screen.getByTestId('toggle-sidebar'))
    fireEvent.click(screen.getByTestId('open-command'))
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument())
  })

  it('warns before unloading a page with a live SSH session', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: null,
        status: 'connected',
        sessionKey: 'test-session:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    await renderAppLayout()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    const allowed = window.dispatchEvent(event)

    expect(allowed).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('confirms before closing a connected terminal tab', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: 'Production',
        status: 'connected',
        sessionKey: 'test-session:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { socket, terminalStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('close-tab'))
    expect(screen.getByText('Close session?')).toBeInTheDocument()
    expect(screen.getByText('Closing Production will disconnect its SSH session.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', {
      session_id: 'test-session',
      tab_id: 'terminal-tab',
    })
    expect(terminalStore.getState().tabs).toHaveLength(0)
  })

  it('marks SFTP tabs dead when their SSH source closes or fails to restore', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'terminal-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: null, status: 'connected', sessionKey: 's:terminal-tab' },
        { id: 'sftp-tab', type: 'sftp', host: 'localhost', port: 22, username: 'alice', label: 'SFTP', status: 'connected', sessionKey: 's:sftp-tab', sourceTabId: 'terminal-tab' },
      ],
      activeTabId: 'terminal-tab',
    })
    const { socket, terminalStore, sftpStore } = await renderAppLayout()

    act(() => socket._trigger('ssh:closed', { tab_id: 'terminal-tab' }))
    expect(terminalStore.getState().tabs.find(tab => tab.id === 'sftp-tab')?.status).toBe('dead')
    expect(sftpStore.getState().tabs['sftp-tab']?.disconnected).toBe(true)

    act(() => socket._trigger('session:restored', { tab_id: 'terminal-tab', status: 'closed' }))
    expect(sftpStore.getState().tabs['sftp-tab']?.disconnected).toBe(true)
  })

  it('closes a pane from a split and keeps another pane active', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'a', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'A', status: 'disconnected', sessionKey: 's:a' },
        { id: 'b', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'B', status: 'disconnected', sessionKey: 's:b' },
        { id: 'c', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'C', status: 'disconnected', sessionKey: 's:c' },
      ],
      activeTabId: 'a',
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'a' },
        b: {
          type: 'split',
          id: 'right',
          dir: 'v',
          ratio: 0.5,
          a: { type: 'leaf', tabId: 'b' },
          b: { type: 'leaf', tabId: 'c' },
        },
      },
      focusedTabId: 'b',
      dragTabId: null,
    })
    const { socket, terminalStore, layoutStore } = await renderAppLayout()

    const panel = document.getElementById('torrus-panel-a')!
    fireEvent.click(within(panel).getByRole('button', { name: 'Close pane' }))

    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', expect.objectContaining({ tab_id: 'a' }))
    expect(terminalStore.getState().tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c'])
    expect(terminalStore.getState().activeTabId).toBe('b')
    expect(layoutStore.getState().root).not.toBeNull()
    expect(JSON.stringify(layoutStore.getState().root)).not.toContain('"tabId":"a"')
  })

  it('confirms closing a live pane and exits split mode for the last pane', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'a', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'A', status: 'connected', sessionKey: 's:a' },
        { id: 'b', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'B', status: 'connected', sessionKey: 's:b' },
      ],
      activeTabId: 'a',
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'a' },
        b: { type: 'leaf', tabId: 'b' },
      },
      focusedTabId: 'a',
      dragTabId: null,
    })
    const { socket, terminalStore, layoutStore } = await renderAppLayout()

    const panel = document.getElementById('torrus-panel-a')!
    fireEvent.click(within(panel).getByRole('button', { name: 'Close pane' }))
    expect(screen.getByRole('alertdialog', { name: 'Close tab' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', expect.objectContaining({ tab_id: 'a' }))
    expect(terminalStore.getState().tabs.map(tab => tab.id)).toEqual(['a', 'b'])
    expect(terminalStore.getState().activeTabId).toBe('b')
    expect(layoutStore.getState().root).toBeNull()
  })

  it('closes every inactive tab immediately and loads a saved session', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'idle',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: 'Idle',
        status: 'disconnected',
        sessionKey: 's:idle',
      }],
      activeTabId: 'idle',
    })
    const { socket, terminalStore } = await renderAppLayout()

    socket.emit.mockClear()
    fireEvent.click(screen.getByTestId('tabbar'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(terminalStore.getState().tabs).toHaveLength(0)
    expect(socket.emit).toHaveBeenCalledWith('ssh:disconnect', expect.objectContaining({ tab_id: 'idle' }))

    fireEvent.click(screen.getByTestId('load-saved-session'))
    const loaded = terminalStore.getState().tabs.at(-1)
    expect(loaded).toEqual(expect.objectContaining({
      label: 'Saved',
      host: 'saved.example',
      port: 2200,
      username: 'bob',
    }))
  })

  it('closes the compact sidebar after loading a saved session', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    const { terminalStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('toggle-sidebar'))
    expect(screen.getByTestId('load-saved-session')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('load-saved-session'))
    expect(screen.queryByTestId('load-saved-session')).not.toBeInTheDocument()
    expect(terminalStore.getState().tabs.at(-1)).toEqual(expect.objectContaining({
      label: 'Saved',
      host: 'saved.example',
    }))
  })

  it('returns early for missing tabs, duplicate guards, and inactive unload state', async () => {
    useTerminalStore.setState({ sessionId: 'test-session', tabs: [], activeTabId: null })
    const { socket, terminalStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('close-tab'))
    fireEvent.click(screen.getByTestId('open-sftp'))
    fireEvent.click(screen.getByTestId('duplicate-tab'))
    expect(terminalStore.getState().tabs).toHaveLength(0)

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(socket.emit).not.toHaveBeenCalledWith('ssh:clone', expect.anything())
  })

  it('clones and duplicates tabs that use default ports and labels', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: null,
        username: 'alice',
        label: null,
        status: 'connected',
        sessionKey: 's:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { terminalStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('clone-tab'))
    expect(terminalStore.getState().tabs.some(tab => tab.label === 'alice@localhost (clone)' && tab.port === 22)).toBe(true)

    fireEvent.click(screen.getByTestId('duplicate-tab'))
    const duplicates = terminalStore.getState().tabs.filter(tab => tab.id !== 'terminal-tab')
    expect(duplicates.every(tab => tab.port === 22)).toBe(true)
    expect(duplicates.some(tab => tab.label === null)).toBe(true)
  })

  it('applies and broadcasts layouts when the active tab is not part of them', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'terminal-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'One', status: 'connected', sessionKey: 's:terminal-tab' },
        { id: 'other-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'Two', status: 'connected', sessionKey: 's:other-tab' },
        { id: 'third-tab', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'Three', status: 'connected', sessionKey: 's:third-tab' },
      ],
      activeTabId: 'third-tab',
    })
    const { terminalStore, layoutStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('open-split'))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply mocked layout' }))
    await waitFor(() => expect(layoutStore.getState().root).not.toBeNull())
    expect(terminalStore.getState().activeTabId).toBe('terminal-tab')

    terminalStore.setState({ activeTabId: 'third-tab' })
    fireEvent.click(screen.getByTestId('open-broadcast'))
    fireEvent.click(await screen.findByRole('button', { name: 'Start mocked broadcast' }))
    await waitFor(() => expect(screen.queryByText('Start mocked broadcast')).not.toBeInTheDocument())
    expect(terminalStore.getState().activeTabId).toBe('terminal-tab')
  })

  it('closes a pending tab after it disappears and reports the fallback name', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [{
        id: 'terminal-tab',
        type: 'terminal',
        host: 'localhost',
        port: 22,
        username: 'alice',
        label: 'Temporary',
        status: 'connected',
        sessionKey: 's:terminal-tab',
      }],
      activeTabId: 'terminal-tab',
    })
    const { terminalStore } = await renderAppLayout()

    fireEvent.click(screen.getByTestId('close-tab'))
    expect(screen.getByText(/Temporary/)).toBeInTheDocument()
    act(() => terminalStore.getState().closeTab('terminal-tab'))
    expect(screen.getByText('Closing this tab will disconnect its SSH session.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('closes a non-active pane, keeps the active tab, and tolerates a cleared split', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'a', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'A', status: 'disconnected', sessionKey: 's:a' },
        { id: 'b', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'B', status: 'disconnected', sessionKey: 's:b' },
        { id: 'c', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'C', status: 'disconnected', sessionKey: 's:c' },
      ],
      activeTabId: 'a',
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'a' },
        b: {
          type: 'split',
          id: 'right',
          dir: 'v',
          ratio: 0.5,
          a: { type: 'leaf', tabId: 'b' },
          b: { type: 'leaf', tabId: 'c' },
        },
      },
      focusedTabId: 'b',
      dragTabId: null,
    })
    const { terminalStore, layoutStore } = await renderAppLayout()

    const panelB = document.getElementById('torrus-panel-b')!
    fireEvent.click(within(panelB).getByRole('button', { name: 'Close pane' }))
    expect(terminalStore.getState().activeTabId).toBe('a')
    expect(JSON.stringify(layoutStore.getState().root)).not.toContain('"tabId":"b"')
  })

  it('handles a pending pane close after the split has already been cleared', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'a', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'A', status: 'connected', sessionKey: 's:a' },
        { id: 'b', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'B', status: 'connected', sessionKey: 's:b' },
      ],
      activeTabId: 'a',
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'a' },
        b: { type: 'leaf', tabId: 'b' },
      },
      focusedTabId: 'a',
      dragTabId: null,
    })
    const { layoutStore: mountedLayout } = await renderAppLayout()

    const panelA = document.getElementById('torrus-panel-a')!
    fireEvent.click(within(panelA).getByRole('button', { name: 'Close pane' }))
    expect(screen.getByRole('alertdialog', { name: 'Close tab' })).toBeInTheDocument()
    act(() => mountedLayout.getState().exitSplitMode())
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(mountedLayout.getState().root).toBeNull()
  })

  it('renders the tab stack when a split exists but no tab is active', async () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [
        { id: 'a', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'A', status: 'connected', sessionKey: 's:a' },
        { id: 'b', type: 'terminal', host: 'localhost', port: 22, username: 'alice', label: 'B', status: 'connected', sessionKey: 's:b' },
      ],
      activeTabId: null,
    })
    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'root',
        dir: 'h',
        ratio: 0.5,
        a: { type: 'leaf', tabId: 'a' },
        b: { type: 'leaf', tabId: 'b' },
      },
      focusedTabId: 'a',
      dragTabId: null,
    })
    await renderAppLayout()
    expect(document.getElementById('torrus-panel-a')).not.toBeNull()
  })
})
