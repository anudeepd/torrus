import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { io, type Socket } from 'socket.io-client'
import { Activity, Check, ChevronLeft, CircleStop, RefreshCw, Shield, Terminal, UserRound, X } from 'lucide-react'
import AdminConfirmModal, { type AdminConfirmationRequest } from './AdminConfirmModal'
import { uuid } from '@/utils/uuid'
import * as m from 'motion/react-m'
import { AnimatePresence } from 'motion/react'
import { surfaceTransition } from '@/motion/tokens'

type AdminSession = {
  session_instance_id: string
  generation: number
  owner_ldap_username: string
  host: string
  port: number
  username: string
  tab_id: string
  created_at: number
  last_activity: number
}

type AdminUser = {
  username: string
  active_sessions: number
  policy_state: string
}

type ActivityEvent = {
  event_id: number
  occurred_at: string
  ldap_username: string
  session_id: string
  tab_id: string
  ssh_host: string | null
  ssh_port: number | null
  ssh_username: string | null
  kind: string
  input: string
  bytes: number
}

type RetentionInfo = {
  cutoff_days: number
  minimum_age_days: number
  eligible_count: number
  terminal_rows_only: boolean
  admin_events_retained: boolean
}

type View = 'sessions' | 'users' | 'activity' | 'stats' | 'retention'
type ActivityFilters = {
  username: string
  input: string
  since: string
}

const ACTIVITY_INPUT_PREVIEW_LIMIT = 240
const ADMIN_NOTICE_TIMEOUT_MS = 5_000

function submitActivityFiltersOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  const form = event.currentTarget.form
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || !form) return
  event.preventDefault()
  form.requestSubmit()
}


type RequestFailure = Error & { status?: number; code?: string }

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function requestError(response: Response, body: Record<string, unknown>): RequestFailure {
  const error = new Error(String(body.message || body.code || `Request failed (${response.status})`)) as RequestFailure
  error.status = response.status
  error.code = typeof body.code === 'string' ? body.code : undefined
  return error
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw requestError(response, body)
  return body
}

function idempotencyKey() {
  return `admin-${uuid()}`
}

export default function AdminConsole({ onClose }: { onClose?: () => void }) {
  const [view, setView] = useState<View>('sessions')
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [sessionTotal, setSessionTotal] = useState(0)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [activityFilters, setActivityFilters] = useState<ActivityFilters>({ username: '', input: '', since: '' })
  const [retention, setRetention] = useState<RetentionInfo | null>(null)
  const [policyFingerprint, setPolicyFingerprint] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RequestFailure | null>(null)
  const [notice, setNotice] = useState('')
  const [lastUpdated, setLastUpdated] = useState(0)
  const [streamState, setStreamState] = useState<'Live' | 'Reconnecting' | 'Polling'>('Polling')
  const [selectedSession, setSelectedSession] = useState<AdminSession | null>(null)
  const [confirmation, setConfirmation] = useState<AdminConfirmationRequest | null>(null)
  const csrfRef = useRef('')
  const refreshTimerRef = useRef<number | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const activityFiltersRef = useRef<ActivityFilters>({ username: '', input: '', since: '' })
  const refreshGenerationRef = useRef(0)

  const loadCsrf = useCallback(async () => {
    const body = await requestJson('/api/admin/csrf')
    csrfRef.current = typeof body.token === 'string' ? body.token : ''
    return csrfRef.current
  }, [])

  const refresh = useCallback(async (filters: ActivityFilters = activityFiltersRef.current) => {
    const generation = ++refreshGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const activityQuery = new URLSearchParams({ limit: '100' })
      if (filters.username.trim()) activityQuery.set('username', filters.username.trim())
      if (filters.input.trim()) activityQuery.set('input', filters.input.trim())
      if (filters.since) activityQuery.set('since', filters.since)
      const [sessionData, userData, activityData, retentionData, policyData] = await Promise.all([
        requestJson('/api/admin/sessions?limit=100'),
        requestJson('/api/admin/users'),
        requestJson(`/api/admin/activity?${activityQuery.toString()}`),
        requestJson('/api/admin/retention?older_than_days=30'),
        requestJson('/api/admin/policy').catch(() => ({} as Record<string, unknown>)),
      ])
      if (generation !== refreshGenerationRef.current) return
      const sessionItems = (sessionData.items || []) as AdminSession[]
      setSessions(sessionItems)
      setSessionTotal(typeof sessionData.total === 'number' ? sessionData.total : sessionItems.length)
      setUsers((userData.items || []) as AdminUser[])
      setActivity((activityData.items || []) as ActivityEvent[])
      setRetention((retentionData || null) as RetentionInfo | null)
      if (typeof policyData.fingerprint === 'string') setPolicyFingerprint(policyData.fingerprint)
      const observed = [sessionData.observed_at, activityData.observed_at, retentionData.observed_at]
        .filter((value): value is number => typeof value === 'number')
      setLastUpdated(observed.length ? Math.max(...observed) * 1000 : Date.now())
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return
      setError(cause instanceof Error ? cause as RequestFailure : new Error('Admin data unavailable.'))
    } finally {
      if (generation === refreshGenerationRef.current) setLoading(false)
    }
  }, [])

  const applyActivityFilters = useCallback((filters: ActivityFilters) => {
    activityFiltersRef.current = filters
    setActivityFilters(filters)
    void refresh(filters)
  }, [refresh])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => { void refresh() }, 10_000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [refresh])

  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] })
    socketRef.current = socket
    socket.on('connect', () => {
      setStreamState('Live')
      socket.emit('admin:subscribe', {}, (response: { ok?: boolean }) => {
        if (!response?.ok) setStreamState('Polling')
      })
    })
    socket.on('admin:event', () => {
      setLastUpdated(Date.now())
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => { void refresh() }, 250)
    })
    socket.on('disconnect', () => setStreamState('Reconnecting'))
    socket.on('connect_error', () => setStreamState('Polling'))
    return () => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
      socket.emit('admin:unsubscribe')
      socket.disconnect()
      socketRef.current = null
    }
  }, [refresh])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), ADMIN_NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [notice])


  const act = useCallback(async (path: string, body: Record<string, unknown>, message: string): Promise<boolean> => {
    setNotice('')
    setError(null)
    const send = async (token: string) => {
      const result = await requestJson(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torrus-CSRF': token,
          'Idempotency-Key': idempotencyKey(),
        },
        body: JSON.stringify(body),
      })
      if (result.ok === false) {
        const failure = new Error(String(result.message || result.code || 'Action failed.')) as RequestFailure
        failure.status = 409
        failure.code = typeof result.code === 'string' ? result.code : undefined
        throw failure
      }
      return result
    }
    try {
      if (!csrfRef.current) await loadCsrf()
      try {
        await send(csrfRef.current)
      } catch (cause) {
        const failure = cause as RequestFailure
        if (failure.code !== 'csrf_required') throw cause
        await loadCsrf()
        await send(csrfRef.current)
      }
      setNotice(message)
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause as RequestFailure : new Error('Action failed.'))
      return false
    }
  }, [loadCsrf, refresh])

  const currentCount = sessionTotal
  const [now, setNow] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const stale = lastUpdated > 0 && now - lastUpdated > 20_000

  if (error?.status === 401 || error?.status === 403) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-950 p-6 text-slate-200">
        <section className="w-full max-w-md rounded-lg border border-surface-800 bg-surface-900 p-6 text-center" aria-labelledby="admin-auth-title">
          <Shield className="mx-auto mb-3 h-6 w-6 text-brand-400" />
          <h1 id="admin-auth-title" className="text-base font-semibold">Admin access required</h1>
          <p className="mt-2 text-sm text-slate-500">{error.message}</p>
          <a className="mt-5 inline-flex rounded-md bg-brand-500 px-3 py-2 text-xs font-medium text-white hover:bg-brand-400" href={`/_auth/login?next=${encodeURIComponent('/admin')}`}>Authenticate</a>
        </section>
      </div>
    )
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={surfaceTransition}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-surface-950 text-slate-200"
    >
      <header className="sticky top-0 z-30 flex min-h-14 shrink-0 items-center gap-3 border-b border-surface-800 bg-surface-900 px-4 sm:px-5">
        {onClose && <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-surface-800 hover:text-slate-200" aria-label="Back to terminal"><ChevronLeft className="h-4 w-4" /></button>}
        <Shield className="h-4 w-4 text-brand-400" />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Admin Console</h1>
          <p className="text-[11px] text-slate-500">Owner-bound sessions, submitted input, and policy controls</p>
        </div>
        <span className={`hidden text-[11px] sm:inline ${stale ? 'text-amber-300' : 'text-slate-500'}`} aria-live="polite">{stale ? 'Stale' : `Updated ${lastUpdated ? age(lastUpdated / 1000) : '—'}`} · {streamState}</span>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="flex items-center gap-1.5 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-52 shrink-0 border-r border-surface-800 bg-surface-900 p-3 sm:block" aria-label="Admin views">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Operator view</p>
          {([
            ['sessions', Terminal, `Sessions (${currentCount})`],
            ['users', UserRound, 'Users & policy'],
            ['activity', Activity, 'Submitted input'],
            ['stats', Activity, 'Stats'],
            ['retention', CircleStop, 'Retention'],
          ] as const).map(([key, Icon, label]) => (
            <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500 hover:bg-surface-800 hover:text-slate-300'}`}><Icon className="h-3.5 w-3.5" /> {label}</button>
          ))}
          <div className="mt-6 rounded-md border border-surface-800 bg-surface-950/60 p-3 text-[11px] leading-relaxed text-slate-600">Controls are owner-bound. Interrupt is best-effort and does not guarantee remote process termination.</div>
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6" aria-live="polite">
          <div className="mx-auto max-w-6xl">
            <div className="mb-4 flex flex-wrap gap-1 sm:hidden" role="tablist" aria-label="Admin views">
              {(['sessions', 'users', 'activity', 'stats', 'retention'] as View[]).map(key => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`rounded-md px-3 py-1.5 text-xs capitalize transition-colors ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500'}`}>{key}</button>)}
            </div>
            {notice && <div className="mb-3 flex items-center gap-2 rounded-md border border-green-900/50 bg-green-950/30 px-3 py-2 text-xs text-green-300" role="status"><Check className="h-3.5 w-3.5" /> {notice}</div>}
            {error && <div className="mb-3 flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300" role="alert"><X className="h-3.5 w-3.5" /> {error.message}</div>}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={view}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={surfaceTransition}
              >
                {view === 'sessions' && <SessionsTable sessions={sessions} total={sessionTotal} selected={selectedSession} onSelect={setSelectedSession} onAction={act} onRequestAction={request => setConfirmation(request)} />}
                {view === 'users' && <UsersTable users={users} fingerprint={policyFingerprint} onAction={act} onRequestAction={request => setConfirmation(request)} />}
                {view === 'activity' && <ActivityTable events={activity} filters={activityFilters} onApplyFilters={applyActivityFilters} />}
                {view === 'stats' && <StatsPanel sessionTotal={sessionTotal} users={users} activity={activity} retention={retention} />}
                {view === 'retention' && <RetentionPanel retention={retention} onAction={act} onRequestAction={request => setConfirmation(request)} />}
              </m.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      <AnimatePresence initial={false}>
        {confirmation && <AdminConfirmModal key={`${confirmation.title}:${confirmation.expected}`} request={confirmation} onClose={() => setConfirmation(null)} />}
      </AnimatePresence>
    </m.div>
  )
}

type Action = (path: string, body: Record<string, unknown>, message: string) => Promise<boolean>
type RequestAction = (request: AdminConfirmationRequest) => void
function AdminTableViewport({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const action = expanded ? 'Collapse' : 'Expand'

  return (
    <div className="relative rounded-lg border border-surface-800 bg-surface-900">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-surface-800 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-600">{expanded ? 'Expanded table' : 'Scrollable table'}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${action} ${label} vertically`}
          onClick={() => setExpanded(value => !value)}
          className="min-h-9 shrink-0 rounded border border-surface-700 px-2.5 py-1.5 text-xs text-brand-300 transition-colors hover:bg-surface-800"
        >
          {action} vertically
        </button>
      </div>
      <div className={`${expanded ? 'max-h-[calc(100dvh-11rem)]' : 'max-h-[70vh]'} overflow-y-auto overflow-x-hidden rounded-b-lg`}>
        {children}
      </div>
    </div>
  )
}


function SessionsTable({ sessions, total, selected, onSelect, onAction, onRequestAction }: { sessions: AdminSession[]; total: number; selected: AdminSession | null; onSelect: (session: AdminSession | null) => void; onAction: Action; onRequestAction: RequestAction }) {
  return (
    <section aria-labelledby="sessions-title">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 id="sessions-title" className="text-base font-semibold">Session inventory</h2>
          <p className="mt-1 text-xs text-slate-500">Active SSH channels only. Instance and generation prevent stale-target actions.</p>
        </div>
        <span className="text-xs text-slate-600">{total} active</span>
      </div>
      <AdminTableViewport label="Session inventory">
        <table className="w-full table-fixed text-left text-xs">
          <caption className="sr-only">Owner-bound active SSH sessions</caption>
          <thead className="sticky top-0 z-10 border-b border-surface-800 bg-surface-900 text-[10px] uppercase tracking-wider text-slate-600">
            <tr><th scope="col" className="px-3 py-2">Owner / target</th><th scope="col" className="px-3 py-2">State</th><th scope="col" className="px-3 py-2">Last activity</th><th scope="col" className="px-3 py-2">Identity</th><th scope="col" className="px-3 py-2 text-right">Controls</th></tr>
          </thead>
          <tbody>
            {sessions.length === 0
              ? <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-600">No active sessions.</td></tr>
              : sessions.map(session => (
                <tr key={session.session_instance_id} className={`border-b border-surface-800/70 last:border-0 ${selected?.session_instance_id === session.session_instance_id ? 'bg-brand-500/5' : ''}`}>
                  <td className="break-words px-3 py-3 [overflow-wrap:anywhere]">
                    <div className="flex flex-wrap items-center gap-2 font-medium text-slate-200">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" />
                      <span className="break-words [overflow-wrap:anywhere]">{session.owner_ldap_username || 'local'}</span>
                      <button type="button" className="break-words text-left text-slate-500 underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-300 [overflow-wrap:anywhere]" onClick={() => onSelect(session)}>{session.host}:{session.port}</button>
                    </div>
                    <div className="mt-1 break-words text-[11px] text-slate-600 [overflow-wrap:anywhere]">SSH account {session.username} · tab {session.tab_id}</div>
                  </td>
                  <td className="px-3 py-3 text-green-300">Connected</td>
                  <td className="px-3 py-3 text-slate-400">{age(session.last_activity)}</td>
                  <td className="break-words px-3 py-3 font-mono text-[10px] text-slate-600 [overflow-wrap:anywhere]">gen {session.generation}<br />{session.session_instance_id}</td>
                  <td className="break-words px-3 py-3 text-right [overflow-wrap:anywhere]">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => onRequestAction({
                          title: 'Interrupt SSH session?',
                          description: `Send Ctrl+C to ${session.username}@${session.host}. This signals the current foreground process. It does not guarantee remote process termination.`,
                          expected: 'INTERRUPT',
                          confirmLabel: 'Send interrupt',
                          action: async () => { await onAction(`/api/admin/sessions/${encodeURIComponent(session.session_instance_id)}/interrupt`, { generation: session.generation }, 'Interrupt queued.') },
                        })}
                        className="rounded border border-amber-900/60 px-2 py-1 text-[11px] text-amber-300 transition-colors hover:bg-amber-950/40"
                      >Interrupt</button>
                      <button
                        type="button"
                        onClick={() => onRequestAction({
                          title: 'Close SSH session?',
                          description: `Disconnect ${session.owner_ldap_username || 'local user'} from ${session.host}.`,
                          expected: 'KICK',
                          confirmLabel: 'Close session',
                          destructive: true,
                          action: async () => { await onAction(`/api/admin/sessions/${encodeURIComponent(session.session_instance_id)}/kick`, { generation: session.generation }, 'Session closed.') },
                        })}
                        className="rounded border border-red-900/60 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-950/40"
                      >Kick</button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </AdminTableViewport>
      {selected && (
        <aside className="mt-3 rounded-lg border border-brand-900/50 bg-brand-950/10 p-4" aria-label="Session details">
          <div className="flex items-start justify-between">
            <div><h3 className="text-sm font-semibold">Session details</h3><p className="mt-1 text-xs text-slate-500">Stable target identity for action confirmation.</p></div>
            <button type="button" onClick={() => onSelect(null)} className="text-slate-500 transition-colors hover:text-slate-200" aria-label="Close session details">×</button>
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-slate-600">Owner</dt><dd>{selected.owner_ldap_username || 'local'}</dd></div>
            <div><dt className="text-slate-600">Target</dt><dd>{selected.host}:{selected.port}</dd></div>
            <div><dt className="text-slate-600">SSH account</dt><dd>{selected.username}</dd></div>
            <div><dt className="text-slate-600">Session instance</dt><dd className="font-mono text-[10px]">{selected.session_instance_id}</dd></div>
          </dl>
        </aside>
      )}
    </section>
  )
}


function AddUserForm({ fingerprint, onAction }: { fingerprint: string; onAction: Action }) {
  const [username, setUsername] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = username.trim()
    if (!normalized || submitting) return
    setSubmitting(true)
    try {
      const ok = await onAction(
        '/api/admin/users',
        { username: normalized, expected_fingerprint: fingerprint },
        'User added. No restart required.',
      )
      if (ok) setUsername('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 flex flex-col gap-2 rounded-lg border border-surface-800 bg-surface-900 p-3 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label htmlFor="admin-add-user" className="text-xs font-medium text-slate-300">Add LDAP user</label>
        <p className="mt-1 text-[11px] text-slate-600">User must already exist in LDAP. Access applies immediately.</p>
        <input id="admin-add-user" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" spellCheck={false} placeholder="username" className="mt-2 w-full rounded border border-surface-700 bg-surface-950 px-2.5 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-700 focus:border-brand-500" />
      </div>
      <button type="submit" disabled={!username.trim() || submitting} className="rounded border border-brand-700/60 px-3 py-2 text-xs text-brand-300 transition-colors hover:bg-brand-950/40 disabled:opacity-50">{submitting ? 'Adding…' : 'Add user'}</button>
    </form>
  )
}

function UsersTable({ users, fingerprint, onAction, onRequestAction }: { users: AdminUser[]; fingerprint: string; onAction: Action; onRequestAction: RequestAction }) {
  return (
    <section aria-labelledby="users-title">
      <div className="mb-3">
        <h2 id="users-title" className="text-base font-semibold">Users & policy</h2>
        <p className="mt-1 text-xs text-slate-500">Allowlist changes use a fingerprinted atomic update. New users apply immediately. Disable also revokes cookies and active tabs.</p>
      </div>
      <AddUserForm fingerprint={fingerprint} onAction={onAction} />
      <AdminTableViewport label="Users and policy">
        <table className="w-full table-fixed text-left text-xs">
          <caption className="sr-only">LDAP users and policy state</caption>
          <thead className="sticky top-0 z-10 border-b border-surface-800 bg-surface-900 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">Identity</th><th scope="col" className="px-3 py-2">Active sessions</th><th scope="col" className="px-3 py-2">Policy</th><th scope="col" className="px-3 py-2 text-right">Action</th></tr></thead>
          <tbody>
            {users.length === 0
              ? <tr><td colSpan={4} className="px-3 py-12 text-center text-slate-600">No configured users observed.</td></tr>
              : users.map(user => (
                <tr key={user.username} className="border-b border-surface-800/70 last:border-0">
                  <td className="break-words px-3 py-3 font-medium [overflow-wrap:anywhere]">{user.username}</td>
                  <td className="break-words px-3 py-3 text-slate-400 [overflow-wrap:anywhere]">{user.active_sessions}</td>
                  <td className="break-words px-3 py-3 text-amber-300 [overflow-wrap:anywhere]">{user.policy_state}</td>
                  <td className="break-words px-3 py-3 text-right [overflow-wrap:anywhere]">
                    {user.policy_state === 'disabled'
                      ? <button type="button" onClick={() => onRequestAction({ title: 'Enable LDAP user?', description: `Re-enable ${user.username} immediately.`, expected: `ENABLE ${user.username}`, confirmLabel: 'Enable user', action: async () => { await onAction(`/api/admin/users/${encodeURIComponent(user.username)}/enable`, { expected_fingerprint: fingerprint }, 'User enabled. No restart required.') } })} className="rounded border border-green-900/60 px-2 py-1 text-[11px] text-green-300 transition-colors hover:bg-green-950/40">Enable</button>
                      : <button type="button" onClick={() => onRequestAction({ title: 'Disable LDAP user?', description: `Revoke ${user.username}'s cookies and active tabs, then disable the user immediately.`, expected: `DISABLE ${user.username}`, confirmLabel: 'Disable user', destructive: true, action: async () => { await onAction(`/api/admin/users/${encodeURIComponent(user.username)}/disable`, { expected_fingerprint: fingerprint }, 'User disabled. No restart required.') } })} className="rounded border border-red-900/60 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-950/40">Disable</button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </AdminTableViewport>
    </section>
  )
}

function ActivityInput({ value, kind }: { value: string; kind: string }) {
  const [expanded, setExpanded] = useState(false)
  if (kind === 'sensitive') {
    return <span className="text-amber-300">Sensitive input redacted</span>
  }
  if (!value) return <span>—</span>
  if (value.length <= ACTIVITY_INPUT_PREVIEW_LIMIT) {
    return <span className="whitespace-pre-wrap break-words">{value}</span>
  }

  return (
    <details className="max-w-[32rem]" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer whitespace-pre-wrap break-words text-slate-200 marker:text-slate-500">
        {value.slice(0, ACTIVITY_INPUT_PREVIEW_LIMIT)}…
        <span className="mt-1 block text-[10px] text-brand-300">Show full input ({value.length} characters)</span>
      </summary>
      {expanded && <pre className="mt-2 max-h-80 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words text-slate-200 [overflow-wrap:anywhere]">{value}</pre>}
    </details>
  )
}
function ActivityFiltersForm({ filters, onApply }: { filters: ActivityFilters; onApply: (filters: ActivityFilters) => void }) {
  const [username, setUsername] = useState(filters.username)
  const [input, setInput] = useState(filters.input)
  const [since, setSince] = useState(filters.since)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onApply({ username, input, since })
  }

  const clear = () => {
    setUsername('')
    setInput('')
    setSince('')
    onApply({ username: '', input: '', since: '' })
  }

  return (
    <form onSubmit={submit} className="mb-4 flex flex-col gap-2 rounded-lg border border-surface-800 bg-surface-900 p-3 sm:flex-row sm:items-end">
      <div>
        <label htmlFor="activity-user" className="block text-[11px] font-medium text-slate-400">User</label>
        <input id="activity-user" type="search" value={username} onChange={event => setUsername(event.target.value)} onKeyDown={submitActivityFiltersOnEnter} autoComplete="off" spellCheck={false} enterKeyHint="search" placeholder="All users" className="mt-1 w-full rounded border border-surface-700 bg-surface-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-brand-500 sm:w-44" />
      </div>
      <div>
        <label htmlFor="activity-input" className="block text-[11px] font-medium text-slate-400">Command</label>
        <input id="activity-input" type="search" value={input} onChange={event => setInput(event.target.value)} onKeyDown={submitActivityFiltersOnEnter} autoComplete="off" spellCheck={false} enterKeyHint="search" placeholder="Search command text" className="mt-1 w-full rounded border border-surface-700 bg-surface-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-brand-500 sm:w-56" />
      </div>
      <div>
        <label htmlFor="activity-since" className="block text-[11px] font-medium text-slate-400">Since</label>
        <input id="activity-since" type="date" value={since} onChange={event => setSince(event.target.value)} onKeyDown={submitActivityFiltersOnEnter} className="mt-1 rounded border border-surface-700 bg-surface-950 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-brand-500" />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="rounded border border-brand-700/60 px-3 py-1.5 text-xs text-brand-300 transition-colors hover:bg-brand-950/40">Apply filters</button>
        <button type="button" onClick={clear} className="rounded border border-surface-700 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200">Clear</button>
      </div>
    </form>
  )
}


function ActivityTable({ events, filters, onApplyFilters }: { events: ActivityEvent[]; filters: ActivityFilters; onApplyFilters: (filters: ActivityFilters) => void }) {
  return (
    <section aria-labelledby="activity-title">
      <div className="mb-3">
        <h2 id="activity-title" className="text-base font-semibold">Submitted input</h2>
        <p className="mt-1 text-xs text-slate-500">Completed terminal input is shown line-by-line with multiline text preserved. Sensitive prompts are recorded only as redaction markers. Terminal output and SSH connection passwords are not recorded.</p>
      </div>
      <ActivityFiltersForm filters={filters} onApply={onApplyFilters} />
      <AdminTableViewport label="Submitted input">
        <table className="w-full table-fixed text-left text-xs">
          <caption className="sr-only">Submitted terminal input events</caption>
          <thead className="sticky top-0 z-10 border-b border-surface-800 bg-surface-900 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Actor</th><th scope="col" className="px-3 py-2">Target</th><th scope="col" className="px-3 py-2">Input</th><th scope="col" className="px-3 py-2">Kind</th><th scope="col" className="px-3 py-2 text-right">Bytes</th></tr></thead>
          <tbody>
            {events.length === 0
              ? <tr><td colSpan={6} className="px-3 py-12 text-center text-slate-600">No submitted input events.</td></tr>
              : events.map(event => (
                <tr key={event.event_id} className="border-b border-surface-800/70 last:border-0">
                  <td className="break-words px-3 py-3 text-slate-400 [overflow-wrap:anywhere]">{new Date(event.occurred_at).toLocaleString()}</td>
                  <td className="break-words px-3 py-3 [overflow-wrap:anywhere]">{event.ldap_username}</td>
                  <td className="break-words px-3 py-3 [overflow-wrap:anywhere]">{event.ssh_host || '—'}:{event.ssh_port || '—'} <span className="break-words text-slate-600 [overflow-wrap:anywhere]">({event.ssh_username || '—'})</span></td>
                  <td className="break-words px-3 py-3 font-mono text-[11px] text-slate-200 [overflow-wrap:anywhere]"><ActivityInput value={event.input} kind={event.kind} /></td>
                  <td className="break-words px-3 py-3 text-slate-400 [overflow-wrap:anywhere]">{event.kind === 'sensitive' ? 'Sensitive (redacted)' : event.kind}</td>
                  <td className="px-3 py-3 text-right text-slate-400">{event.bytes}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </AdminTableViewport>
    </section>
  )
}
function StatsPanel({ sessionTotal, users, activity, retention }: { sessionTotal: number; users: AdminUser[]; activity: ActivityEvent[]; retention: RetentionInfo | null }) {
  const activeUsers = users.filter(user => user.active_sessions > 0).length
  const disabledUsers = users.filter(user => user.policy_state === 'disabled').length
  const stats = [
    { label: 'Active users', value: activeUsers, detail: 'Users with one or more open SSH sessions.' },
    { label: 'Active sessions', value: sessionTotal, detail: 'Server-reported live SSH channels.' },
    { label: 'Configured users', value: users.length, detail: 'Users currently returned by policy inventory.' },
    { label: 'Requests loaded', value: activity.length, detail: 'Latest request rows in current activity view.' },
    { label: 'Disabled users', value: disabledUsers, detail: 'Policy-disabled users in current inventory.' },
    { label: 'Retention eligible', value: retention?.eligible_count ?? 0, detail: `Terminal rows older than ${retention?.cutoff_days ?? 30} days.` },
  ]

  return (
    <section aria-labelledby="stats-title">
      <div className="mb-4">
        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Snapshot</p>
        <h2 id="stats-title" className="text-xl font-semibold tracking-tight">Admin stats</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">Live counts from latest successful refresh. Request count reflects current loaded activity rows; session count includes server total.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map(stat => (
          <article key={stat.label} className="rounded-lg border border-surface-800 bg-surface-900 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">{stat.label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-100">{stat.value}</p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{stat.detail}</p>
          </article>
        ))}
      </div>
    </section>
  )
}


function RetentionPanel({ retention, onAction, onRequestAction }: { retention: RetentionInfo | null; onAction: Action; onRequestAction: RequestAction }) {
  const [days, setDays] = useState(retention?.cutoff_days || 30)
  const ageLabel = days === 1 ? '1 day' : `${days} days`
  return (
    <section aria-labelledby="retention-title" className="max-w-xl">
      <h2 id="retention-title" className="text-base font-semibold">Manual audit cleanup</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">Remove completed terminal input older than selected age. Administrator action records stay.</p>
      <label className="mt-5 block text-xs text-slate-400" htmlFor="retention-days">Delete input older than</label>
      <input id="retention-days" type="number" min={7} max={3650} value={days} onChange={event => setDays(Number(event.target.value))} className="mt-1 w-32 rounded border border-surface-700 bg-surface-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-brand-500" />
      <div className="mt-4 rounded border border-surface-800 bg-surface-900 p-3 text-xs text-slate-400">
        <dl className="grid gap-2 sm:grid-cols-3">
          <div><dt className="text-slate-600">Eligible rows</dt><dd className="text-slate-200">{retention?.eligible_count ?? '—'}</dd></div>
          <div><dt className="text-slate-600">Minimum age</dt><dd className="text-slate-200">{retention?.minimum_age_days ?? 7} days</dd></div>
          <div><dt className="text-slate-600">Admin records</dt><dd className="text-slate-200">Kept</dd></div>
        </dl>
      </div>
      <button type="button" onClick={() => onRequestAction({ title: 'Delete terminal input?', description: `Delete terminal input older than ${ageLabel}. This cannot be undone. Administrator action records will remain.`, expected: 'PURGE', confirmLabel: 'Delete rows', destructive: true, action: async () => { await onAction('/api/admin/retention/purge', { older_than_days: days, confirmation: 'PURGE' }, `Deleted terminal input older than ${ageLabel}. Administrator action records remain.`) } })} className="mt-4 rounded border border-red-900/60 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-950/40">Review deletion</button>
    </section>
  )
}
