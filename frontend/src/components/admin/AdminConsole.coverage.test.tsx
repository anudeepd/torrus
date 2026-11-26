import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockSocket, type MockSocket } from '@/test/mocks/socket'

const sessions = [
  {
    session_instance_id: 'instance-1',
    generation: 2,
    owner_ldap_username: '',
    host: 'db01',
    port: 22,
    username: 'root',
    tab_id: 'tab-1',
    created_at: 1,
    last_activity: Math.floor(Date.now() / 1000),
  },
  {
    session_instance_id: 'instance-2',
    generation: 3,
    owner_ldap_username: 'alice',
    host: 'db02',
    port: 2222,
    username: 'alice',
    tab_id: 'tab-2',
    created_at: 2,
    last_activity: Math.floor(Date.now() / 1000) - 3700,
  },
  {
    session_instance_id: 'instance-3',
    generation: 4,
    owner_ldap_username: 'bob',
    host: 'db03',
    port: 22,
    username: 'bob',
    tab_id: 'tab-3',
    created_at: 3,
    last_activity: Math.floor(Date.now() / 1000) - 90_000,
  },
  {
    session_instance_id: 'instance-4',
    generation: 5,
    owner_ldap_username: 'carol',
    host: 'db04',
    port: 22,
    username: 'carol',
    tab_id: 'tab-4',
    created_at: 4,
    last_activity: Math.floor(Date.now() / 1000) - 180,
  },
]

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function mountAdmin(options: {
  sessionStatus?: number
  sessionBody?: unknown
  users?: unknown[]
  activity?: unknown[]
  retention?: unknown
  policy?: unknown
  csrf?: unknown
  rawBody?: boolean
  post?: (body: unknown) => Response
} = {}) {
  vi.resetModules()
  const socket = { ...createMockSocket(), disconnect: vi.fn() }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (options.rawBody) return json({})
    if (init?.method === 'POST') {
      return options.post?.(JSON.parse(String(init.body))) ?? json({ ok: true })
    }
    if (url.includes('/api/admin/sessions')) {
      return json(
        options.sessionBody ?? { items: sessions, total: sessions.length, observed_at: 1 },
        options.sessionStatus ?? 200,
      )
    }
    if (url.includes('/api/admin/users')) {
      return json({ items: options.users ?? [], observed_at: 1 })
    }
    if (url.includes('/api/admin/activity')) {
      return json(
        options.activity !== undefined
          ? { items: options.activity }
          : { items: [], observed_at: 1 },
      )
    }
    if (url.includes('/api/admin/retention')) {
      return json(
        options.retention ?? {
          cutoff_days: 30,
          minimum_age_days: 7,
          eligible_count: 2,
          observed_at: 1,
        },
      )
    }
    if (url.includes('/api/admin/policy')) {
      return json(options.policy ?? { fingerprint: 'fp' })
    }
    if (url.includes('/api/admin/csrf')) {
      return json(options.csrf ?? { token: 'csrf' })
    }
    return json({}, 500)
  })
  vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(3)
      return bytes
    },
  })
  const { default: AdminConsole } = await import('./AdminConsole')
  const view = render(<AdminConsole onClose={vi.fn()} />)
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/activity'),
      expect.anything(),
    ),
  )
  return { fetchMock, socket, ...view }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('AdminConsole coverage', () => {
  it('shows the authentication surface for an unauthorized response', async () => {
    await mountAdmin({
      sessionStatus: 401,
      sessionBody: { message: 'Login required' },
    })
    expect(await screen.findByText('Admin access required')).toBeInTheDocument()
    expect(screen.getByText('Login required')).toBeInTheDocument()
  })

  it('reacts to every socket state and refreshes after an event', async () => {
    let subscribeCallback: ((response: { ok?: boolean }) => void) | undefined
    const { socket, fetchMock } = await mountAdmin()
    const mock = socket as MockSocket & { emit: ReturnType<typeof vi.fn> }
    mock.emit.mockImplementation((event, _data, callback) => {
      if (event === 'admin:subscribe') subscribeCallback = callback
      return undefined
    })

    act(() => socket._trigger('connect'))
    expect(screen.getByText(/Live/)).toBeInTheDocument()
    act(() => subscribeCallback?.({ ok: false }))
    expect(screen.getByText(/Polling/)).toBeInTheDocument()
    act(() => socket._trigger('disconnect'))
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    act(() => socket._trigger('connect_error'))
    expect(screen.getByText(/Polling/)).toBeInTheDocument()

    const before = fetchMock.mock.calls.length
    vi.useFakeTimers()
    act(() => socket._trigger('admin:event'))
    act(() => vi.advanceTimersByTime(250))
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('retries CSRF once and surfaces non-CSRF action failures', async () => {
    let attempt = 0
    const { fetchMock } = await mountAdmin({
      post: () => {
        attempt += 1
        if (attempt === 1) return json({ code: 'csrf_required' }, 403)
        return json({ ok: true })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'carol' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('User added'),
    )
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/csrf')),
    ).toHaveLength(2)

    attempt = 10
    cleanup()
    const failing = await mountAdmin({
      post: () => json({ ok: false, code: 'nope', message: 'No permission' }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'dave' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No permission')
    expect(failing.fetchMock).toHaveBeenCalled()
  })

  it('renders session rows, ages, details, and action confirmations', async () => {
    const { fetchMock } = await mountAdmin()
    expect(screen.getByText(/^\d+s ago$/)).toBeInTheDocument()
    expect(screen.getByText('1h ago')).toBeInTheDocument()
    expect(screen.getByText('1d ago')).toBeInTheDocument()
    expect(screen.getByText('3m ago')).toBeInTheDocument()
    expect(screen.getByText('local')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'db01:22' }))
    expect(screen.getByRole('complementary', { name: 'Session details' })).toHaveTextContent(
      'instance-1',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close session details' }))

    const [interrupt] = screen.getAllByRole('button', { name: 'Interrupt' })
    fireEvent.click(interrupt)
    let dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Type INTERRUPT/), {
      target: { value: 'INTERRUPT' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send interrupt' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const [kick] = screen.getAllByRole('button', { name: 'Kick' })
    fireEvent.click(kick)
    dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText(/Type KICK/), {
      target: { value: 'KICK' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close session' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/interrupt'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/kick'))).toBe(true)
  })

  it('shows the empty users table and clears activity filters', async () => {
    const { fetchMock } = await mountAdmin()
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    expect(screen.getByText(/No configured users observed/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'ls' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'command' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'h' } })
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('Until'), { target: { value: '2026-01-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === '/api/admin/activity?limit=100',
        ),
      ).toBe(true),
    )
    expect(screen.getByLabelText('User')).toHaveValue('')
  })

  it('moves the mobile tabs with arrow keys and ignores other keys', async () => {
    await mountAdmin()
    const tablist = screen.getByRole('tablist', { name: 'Admin views' })
    fireEvent.keyDown(tablist, { key: 'x' })
    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Users & policy' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('closes the admin console from its back button', async () => {
    vi.resetModules()
    const socket = { ...createMockSocket(), disconnect: vi.fn() }
    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/sessions')) return json({ items: [], observed_at: 1 })
      if (url.includes('/users')) return json({ items: [] })
      if (url.includes('/activity')) return json({ items: [] })
      if (url.includes('/retention')) return json({})
      if (url.includes('/policy')) return json({})
      return json({})
    }))
    const onClose = vi.fn()
    const { default: AdminConsole } = await import('./AdminConsole')
    render(<AdminConsole onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to terminal' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders fallback fields and empty activity input', async () => {
    await mountAdmin({
      sessionBody: { items: [] },
      activity: [
        {
          event_id: 1,
          occurred_at: '2026-01-01T00:00:00.000Z',
          ldap_username: 'alice',
          session_id: 's',
          tab_id: 't',
          ssh_host: null,
          ssh_port: null,
          ssh_username: null,
          kind: 'sftp_upload',
          input: '',
          bytes: 1,
        },
      ],
      retention: null,
      policy: {},
      csrf: {},
    })
    expect(screen.getByText('0 active')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    const table = await screen.findByRole('table', {
      name: 'Submitted terminal input events',
    })
    expect(table).toHaveTextContent('—:— (—)')
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('ignores an empty add-user submit and an Enter key with no form', async () => {
    await mountAdmin()
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    const input = screen.getByLabelText('Add LDAP user')
    fireEvent.submit(input.closest('form')!)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'x' })

    const detached = document.createElement('input')
    document.body.appendChild(detached)
    fireEvent.keyDown(detached, { key: 'Enter' })
  })

  it('shows an action failure that is not an Error object', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw 'offline'
      const url = String(input)
      if (url.includes('/sessions')) return json({ items: [], observed_at: 1 })
      if (url.includes('/users')) return json({ items: [] })
      if (url.includes('/activity')) return json({ items: [], observed_at: 1 })
      if (url.includes('/retention')) return json({ observed_at: 1 })
      if (url.includes('/policy')) return json({})
      return json({ token: 'csrf' })
    })
    vi.resetModules()
    const socket = { ...createMockSocket(), disconnect: vi.fn() }
    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: AdminConsole } = await import('./AdminConsole')
    render(<AdminConsole />)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/activity'),
        expect.anything(),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), {
      target: { value: 'eve' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Action failed.')
  })

  it('handles missing response arrays and generic request errors', async () => {
    await mountAdmin({ rawBody: true })
    expect(screen.getByText('0 active')).toBeInTheDocument()

    cleanup()
    await mountAdmin({
      sessionStatus: 401,
      sessionBody: { code: 'ONLY_CODE' },
    })
    expect(screen.getByText('ONLY_CODE')).toBeInTheDocument()

    cleanup()
    await mountAdmin({
      sessionStatus: 401,
      sessionBody: {},
    })
    expect(screen.getByText('Request failed (401)')).toBeInTheDocument()
  })

  it('coalesces bursts of server events and accepts a missing CSRF token', async () => {
    const { socket, fetchMock } = await mountAdmin({ csrf: {} })
    vi.useFakeTimers()
    act(() => {
      socket._trigger('admin:event')
      socket._trigger('admin:event')
    })
    act(() => vi.advanceTimersByTime(250))
    expect(fetchMock).toHaveBeenCalled()
    vi.useRealTimers()

    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), {
      target: { value: 'no-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/admin/users' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('keeps command groups separate when any grouping identity differs', async () => {
    const event = (index: number, overrides: Record<string, unknown> = {}) => ({
      event_id: index,
      occurred_at: `2026-08-02T00:00:${String(index).padStart(2, '0')}.000Z`,
      ldap_username: 'alice',
      session_id: 's',
      tab_id: 't',
      ssh_host: 'h',
      ssh_port: 22,
      ssh_username: 'u',
      kind: 'command',
      input: `line-${index}`,
      bytes: 1,
      ...overrides,
    })
    await mountAdmin({
      activity: [
        event(9),
        event(8, { ssh_host: null }),
        event(7, { ssh_port: null }),
        event(6, { ssh_username: null }),
        event(5, { tab_id: 'other' }),
        event(4),
        event(3),
        event(0, { occurred_at: '2026-08-01T23:59:45.000Z' }),
      ],
      retention: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    const table = await screen.findByRole('table', {
      name: 'Submitted terminal input events',
    })
    expect(table).toHaveTextContent('—:22 (u)')
    expect(table).toHaveTextContent('h:— (u)')
    expect(table).toHaveTextContent('h:22 (—)')
    expect(table).toHaveTextContent('command · 2 lines')
  })

  it('renders null retention fallbacks in stats and retention views', async () => {
    await mountAdmin({
      retention: 0,
      activity: [],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Stats' }))
    expect(screen.getByText('Retention eligible')).toBeInTheDocument()
    expect(screen.getByText('Terminal rows older than 30 days.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retention' }))
    const days = screen.getByLabelText('Delete input older than')
    expect(days).toHaveValue(30)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('7 days')).toBeInTheDocument()
    fireEvent.change(days, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete input…' }))
    expect(screen.getByText(/older than 1 day/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('surfaces action failures with missing and non-string response codes', async () => {
    let response: Record<string, unknown> = { ok: false }
    await mountAdmin({ post: () => json(response) })

    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'carol' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Action failed.')

    cleanup()
    response = { ok: false, code: 123 }
    await mountAdmin({ post: () => json(response) })
    fireEvent.click(screen.getByRole('button', { name: 'Users & policy' }))
    fireEvent.change(screen.getByLabelText('Add LDAP user'), { target: { value: 'dave' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('123')
  })

  it('marks the live snapshot stale after the freshness window', async () => {
    await mountAdmin({
      sessionBody: {
        items: [],
        total: 0,
        observed_at: 1,
      },
    })
    await waitFor(
      () => expect(screen.getByText(/Stale/)).toBeInTheDocument(),
      { timeout: 3_000 },
    )
  })

  it('ignores IME Enter in activity filters and renders empty connection fields', async () => {
    await mountAdmin({
      activity: [
        {
          event_id: 1,
          occurred_at: '2026-01-01T00:00:00.000Z',
          ldap_username: 'alice',
          session_id: 's',
          tab_id: 't',
          ssh_host: '',
          ssh_port: 0,
          ssh_username: '',
          kind: 'command',
          input: 'ls',
          bytes: 1,
        },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submitted input' }))
    const search = screen.getByLabelText('Search')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })
    search.dispatchEvent(composing)
    expect(composing.defaultPrevented).toBe(false)
    expect(screen.getByRole('table', { name: 'Submitted terminal input events' })).toHaveTextContent('—:— (—)')
  })

  it('reports a non-Error refresh failure as unavailable', async () => {
    vi.resetModules()
    const socket = { ...createMockSocket(), disconnect: vi.fn() }
    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sessions')) throw 'offline'
      return json({})
    }))
    const { default: AdminConsole } = await import('./AdminConsole')
    render(<AdminConsole />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin data unavailable.')
  })
})
