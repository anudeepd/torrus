import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockSocket } from '@/test/mocks/socket'

function response(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function activity(eventId: number, input: string) {
  return {
    event_id: eventId,
    occurred_at: '2026-08-02T00:00:00.000Z',
    ldap_username: 'alice',
    session_id: 'session-1',
    tab_id: 'tab-1',
    ssh_host: 'example.com',
    ssh_port: 22,
    ssh_username: 'root',
    kind: 'command',
    input,
    bytes: input.length,
  }
}

describe('AdminConsole activity refresh ordering', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps newer filtered activity when older polling response finishes later', async () => {
    vi.resetModules()
    const socket = { ...createMockSocket(), disconnect: vi.fn() }
    const activityRequests: Array<{
      url: string
      resolve: (value: Response) => void
    }> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/admin/activity')) {
        return new Promise<Response>((resolve) => {
          activityRequests.push({ url, resolve })
        })
      }
      if (init?.method === 'POST') return Promise.resolve(response({ ok: true }))
      if (url.includes('/api/admin/sessions')) return Promise.resolve(response({ items: [], observed_at: 1 }))
      if (url.includes('/api/admin/users')) return Promise.resolve(response({ items: [], observed_at: 1 }))
      if (url.includes('/api/admin/retention')) {
        return Promise.resolve(response({ cutoff_days: 30, minimum_age_days: 7, eligible_count: 0, observed_at: 1 }))
      }
      if (url.includes('/api/admin/policy')) return Promise.resolve(response({ fingerprint: 'fingerprint-1' }))
      if (url.includes('/api/admin/csrf')) return Promise.resolve(response({ token: 'csrf-1' }))
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7)
        return bytes
      },
    })

    const { default: AdminConsole } = await import('./AdminConsole')
    render(<AdminConsole />)
    await waitFor(() => expect(activityRequests).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(activityRequests).toHaveLength(2))

    activityRequests[1].resolve(response({ items: [activity(2, 'new-command')], observed_at: 2 }))
    await waitFor(() => expect(screen.getByText('new-command')).toBeInTheDocument())

    activityRequests[0].resolve(response({ items: [activity(1, 'old-command')], observed_at: 1 }))
    await waitFor(() => expect(screen.queryByText('old-command')).not.toBeInTheDocument())
    expect(screen.getByText('new-command')).toBeInTheDocument()
  })
})
