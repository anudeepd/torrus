import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMockSocket } from '@/test/mocks/socket'
import { useTerminalStore } from '@/store/terminalStore'
import { AUTH_REDIRECT_EVENT } from '@/utils/authRedirect'

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
      onCloseAllTabs,
      onCloseTab,
      onOpenAdmin,
    }: {
      onCloseAllTabs: () => void
      onCloseTab: (tabId: string) => void
      onOpenAdmin?: () => void
    }) => (
      <>
        <button type="button" data-testid="tabbar" onClick={onCloseAllTabs}>Close All</button>
        <button type="button" data-testid="close-tab" onClick={() => onCloseTab('terminal-tab')}>Close Tab</button>
        <button type="button" data-testid="open-admin" onClick={() => onOpenAdmin?.()}>Admin</button>
      </>
    ),
  }))
  vi.doMock('./SessionSidebar', () => ({
    default: () => <aside data-testid="sidebar" />,
  }))
  vi.doMock('@/components/terminal/TerminalPane', () => ({
    default: () => <div data-testid="terminal-pane" />,
  }))
  vi.doMock('@/components/sftp/SFTPBrowser', () => ({
    default: () => <div data-testid="sftp-browser" />,
  }))

  const { default: AppLayout } = await import('./AppLayout')
  render(strict ? <StrictMode><AppLayout navigateToAdmin={navigateToAdmin} /></StrictMode> : <AppLayout navigateToAdmin={navigateToAdmin} />)

    await waitFor(() => {
      expect(socket.on).toHaveBeenCalledWith('ssh:error', expect.any(Function))
      expect(socket.on).toHaveBeenCalledWith('sftp:error', expect.any(Function))
    })

  return { socket, redirectToLdapLogin }
}

describe('AppLayout LDAP auth handling', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.doUnmock('@/hooks/useSocket')
    vi.doUnmock('@/utils/authRedirect')
    vi.doUnmock('./TabBar')
    vi.doUnmock('./SessionSidebar')
    vi.doUnmock('@/components/terminal/TerminalPane')
    vi.doUnmock('@/components/sftp/SFTPBrowser')
    useTerminalStore.setState({ sessionId: '', tabs: [], activeTabId: null })
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

    await renderAppLayout()

    act(() => {
      window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT))
    })
    const event = new Event('beforeunload', { cancelable: true })
    const allowed = window.dispatchEvent(event)

    expect(allowed).toBe(true)
    expect(event.defaultPrevented).toBe(false)
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

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })

    expect(screen.getByText('Close SFTP tab?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

    expect(socket.emit).toHaveBeenCalledWith('sftp:close', {
      session_id: 'test-session',
      tab_id: 'sftp-tab',
    })
    expect(socket.emit).not.toHaveBeenCalledWith('ssh:disconnect', expect.anything())
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

    expect(screen.getByRole('dialog', { name: 'Close all tabs' })).toBeInTheDocument()
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
})
