import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockSocket } from '@/test/mocks/socket'

const longInput = `echo ${'x'.repeat(500)}`
const multilineInput = 'printf "first\\nsecond"\nnext-command'

function response(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as Response
}

async function renderAdmin() {
  vi.resetModules()
  const socket = { ...createMockSocket(), disconnect: vi.fn() }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') return response({ ok: true })
    if (url.includes('/api/admin/sessions')) return response({ items: [], observed_at: 1 })
    if (url.includes('/api/admin/users')) return response({
      items: [
        { username: 'alice', active_sessions: 2, policy_state: 'allowed' },
        { username: 'bob', active_sessions: 0, policy_state: 'disabled' },
      ],
      observed_at: 1,
    })
    if (url.includes('/api/admin/activity')) {
      return response({
        items: [
          {
            event_id: 1,
            occurred_at: '2026-08-02T00:00:00.000Z',
            ldap_username: 'alice',
            session_id: 'session-1',
            tab_id: 'tab-1',
            ssh_host: 'example.com',
            ssh_port: 22,
            ssh_username: 'root',
            kind: 'command',
            input: longInput,
            bytes: longInput.length,
          },
          {
            event_id: 2,
            occurred_at: '2026-08-02T00:01:00.000Z',
            ldap_username: 'alice',
            session_id: 'session-1',
            tab_id: 'tab-1',
            ssh_host: 'example.com',
            ssh_port: 22,
            ssh_username: 'root',
            kind: 'sensitive',
            input: 'Sensitive input redacted',
            bytes: 0,
          },
          {
            event_id: 3,
            occurred_at: '2026-08-02T00:02:00.000Z',
            ldap_username: 'alice',
            session_id: 'session-1',
            tab_id: 'tab-1',
            ssh_host: 'example.com',
            ssh_port: 22,
            ssh_username: 'root',
            kind: 'command',
            input: multilineInput,
            bytes: multilineInput.length,
          },
        ],
        observed_at: 1,
      })
    }
    if (url.includes('/api/admin/retention')) {
      return response({ cutoff_days: 30, minimum_age_days: 7, eligible_count: 1, observed_at: 1 })
    }
    if (url.includes('/api/admin/policy')) return response({ fingerprint: 'fingerprint-1' })
    if (url.includes('/api/admin/csrf')) return response({ token: 'csrf-1' })
    throw new Error(`Unexpected request: ${url}`)
  })

  vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(7)
      return bytes
    },
  })

  // Import after socket mocking so AdminConsole's module-level client uses test transport.
  const { default: AdminConsole } = await import('./AdminConsole')
  render(<AdminConsole />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity?limit=100', expect.anything()))
  return { fetchMock, socket }
}

describe('AdminConsole', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('truncates long submitted input until expanded and keeps admin content scrollable', async () => {
    await renderAdmin()

    expect(screen.getByRole('main')).toHaveClass('overflow-y-auto')
    fireEvent.click(screen.getByRole('tab', { name: 'activity' }))

    await waitFor(() => expect(screen.getByText(/Show full input/)).toBeInTheDocument())
    const multilineEvent = screen.getByText((content) =>
      content.includes('printf "first\\nsecond"') && content.includes('next-command'),
    )
    expect(multilineEvent).toHaveClass('whitespace-pre-wrap')
    expect(screen.getByText('Sensitive input redacted')).toBeInTheDocument()
    expect(screen.queryByText(longInput)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Show full input/))
    await waitFor(() => {
      expect(screen.getByText(longInput)).toBeInTheDocument()
      expect(screen.getByText(longInput)).toHaveClass('whitespace-pre-wrap')
    })
  })
  it('keeps each admin table header fixed inside scrollable content', async () => {
    await renderAdmin()

    const expectFixedTable = (name: string) => {
      const table = screen.getByRole('table', { name })
      expect(table).toHaveClass('table-fixed')
      expect(table.parentElement).toHaveClass('max-h-[70vh]', 'overflow-y-auto', 'overflow-x-hidden')
      expect(table.parentElement?.parentElement).not.toHaveClass('overflow-hidden')
      expect(table.querySelector('thead')).toHaveClass('sticky', 'top-0', 'z-10')
    }

    expect(screen.getByRole('banner')).toHaveClass('sticky', 'top-0', 'z-30')

    expectFixedTable('Owner-bound active SSH sessions')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Session inventory vertically' }))
    expect(screen.getByRole('table', { name: 'Owner-bound active SSH sessions' }).parentElement).toHaveClass('max-h-[calc(100dvh-11rem)]')
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    expectFixedTable('LDAP users and policy state')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Users and policy vertically' }))
    expect(screen.getByRole('table', { name: 'LDAP users and policy state' }).parentElement).toHaveClass('max-h-[calc(100dvh-11rem)]')
    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    expectFixedTable('Submitted terminal input events')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Submitted input vertically' }))
    expect(screen.getByRole('table', { name: 'Submitted terminal input events' }).parentElement).toHaveClass('max-h-[calc(100dvh-11rem)]')
  })

  it('shows live admin counts in stats view', async () => {
    await renderAdmin()

    fireEvent.click(screen.getByRole('button', { name: 'Stats' }))
    expect(screen.getByRole('heading', { name: 'Admin stats' })).toBeInTheDocument()
    expect(screen.getByText('Active users')).toBeInTheDocument()
    expect(screen.getByText('Configured users')).toBeInTheDocument()
    expect(screen.getByText('Requests loaded')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })


  it('adds an LDAP user without a restart', async () => {
    const { fetchMock } = await renderAdmin()

    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('User added. No restart required.'))
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/admin/users' && init?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      username: 'bob',
      expected_fingerprint: 'fingerprint-1',
    })
  })

  it('passes partial user and command filters when the activity form is submitted by keyboard', async () => {
    const { fetchMock } = await renderAdmin()

    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'ali' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'status' } })
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-08-01' } })
    fireEvent.keyDown(screen.getByLabelText('User'), { key: 'Enter' })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/activity?limit=100&username=ali&input=status&since=2026-08-01',
      expect.anything(),
    ))
  })

  it('auto-dismisses admin success notices after five seconds', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    await renderAdmin()

    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('User added. No restart required.'))

    const noticeTimer = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)
    expect(noticeTimer).toBeDefined()
    act(() => (noticeTimer?.[0] as () => void)())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('uses internal purge confirmation and HTTP-safe idempotency keys', async () => {
    const { fetchMock } = await renderAdmin()

    fireEvent.click(screen.getByRole('tab', { name: 'retention' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Type PURGE to confirm'), { target: { value: 'PURGE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete rows' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Deleted terminal input older than 30 days'))
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    const headers = postCall?.[1]?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^admin-[0-9a-z-]+$/)
  })
})
