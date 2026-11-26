import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { useServerConfigStore } from '@/store/serverConfigStore'

vi.mock('./components/layout/AppLayout', () => ({
  default: ({ navigateToAdmin }: { navigateToAdmin: () => void }) => (
    <button type="button" onClick={navigateToAdmin}>Open admin</button>
  ),
}))

vi.mock('./components/admin/AdminConsole', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>Close admin</button>
  ),
}))

describe('App', () => {
  const load = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    load.mockClear()
    useServerConfigStore.setState({
      load,
      ldapEnabled: false,
      isAdmin: false,
      ldapIdleTimeout: 0,
    })
  })

  it('loads server config and navigates between terminal and admin routes', async () => {
    render(<App />)

    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Open admin' }))
    expect(window.location.pathname).toBe('/admin')

    fireEvent.click(await screen.findByRole('button', { name: 'Close admin' }))
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('button', { name: 'Open admin' })).toBeInTheDocument()
  })

  it('tracks browser back and forward navigation', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Open admin' })

    act(() => {
      window.history.pushState({}, '', '/admin')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(await screen.findByRole('button', { name: 'Close admin' })).toBeInTheDocument()
  })
})
