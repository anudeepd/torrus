import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMockSocket } from '@/test/mocks/socket'
import { useTerminalStore } from '@/store/terminalStore'
import { AUTH_REDIRECT_EVENT } from '@/utils/authRedirect'

async function renderAppLayout({ strict = false }: { strict?: boolean } = {}) {
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
    default: () => <div data-testid="tabbar" />,
  }))
  vi.doMock('./SessionSidebar', () => ({
    default: () => <aside data-testid="sidebar" />,
  }))
  vi.doMock('@/components/terminal/TerminalPane', () => ({
    default: () => <div data-testid="terminal-pane" />,
  }))

  const { default: AppLayout } = await import('./AppLayout')
  render(strict ? <StrictMode><AppLayout /></StrictMode> : <AppLayout />)

  await waitFor(() => {
    expect(socket.on).toHaveBeenCalledWith('ssh:error', expect.any(Function))
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
})
