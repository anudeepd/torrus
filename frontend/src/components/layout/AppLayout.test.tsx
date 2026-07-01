import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createMockSocket } from '@/test/mocks/socket'
import { useTerminalStore } from '@/store/terminalStore'
import { AUTH_REDIRECT_EVENT } from '@/utils/authRedirect'

async function renderAppLayout() {
  vi.resetModules()

  const socket = createMockSocket()
  const redirectToLdapLogin = vi.fn()

  vi.doMock('@/hooks/useSocket', () => ({
    getSocket: () => socket,
  }))
  vi.doMock('@/utils/authRedirect', () => ({
    AUTH_REDIRECT_EVENT,
    redirectToLdapLogin,
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
  render(<AppLayout />)

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

    window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT))
    const event = new Event('beforeunload', { cancelable: true })
    const allowed = window.dispatchEvent(event)

    expect(allowed).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })
})
