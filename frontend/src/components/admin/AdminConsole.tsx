import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { Activity, Check, ChevronLeft, CircleStop, RefreshCw, Shield, Terminal, UserRound, X } from 'lucide-react'

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
  bytes: number
}

type RetentionInfo = {
  cutoff_days: number
  minimum_age_days: number
  eligible_count: number
  terminal_rows_only: boolean
  admin_events_retained: boolean
}

type View = 'sessions' | 'users' | 'activity' | 'retention'

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
  return `admin-${crypto.randomUUID()}`
}

export default function AdminConsole({ onClose }: { onClose?: () => void }) {
  const [view, setView] = useState<View>('sessions')
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [retention, setRetention] = useState<RetentionInfo | null>(null)
  const [policyFingerprint, setPolicyFingerprint] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RequestFailure | null>(null)
  const [notice, setNotice] = useState('')
  const [lastUpdated, setLastUpdated] = useState(0)
  const [streamState, setStreamState] = useState<'Live' | 'Reconnecting' | 'Polling'>('Polling')
  const [selectedSession, setSelectedSession] = useState<AdminSession | null>(null)
  const csrfRef = useRef('')
  const refreshTimerRef = useRef<number | null>(null)
  const socketRef = useRef<Socket | null>(null)

  const loadCsrf = useCallback(async () => {
    const body = await requestJson('/api/admin/csrf')
    csrfRef.current = typeof body.token === 'string' ? body.token : ''
    return csrfRef.current
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sessionData, userData, activityData, retentionData, policyData] = await Promise.all([
        requestJson('/api/admin/sessions?limit=100'),
        requestJson('/api/admin/users'),
        requestJson('/api/admin/activity?limit=100'),
        requestJson('/api/admin/retention?older_than_days=30'),
        requestJson('/api/admin/policy').catch(() => ({} as Record<string, unknown>)),
      ])
      setSessions((sessionData.items || []) as AdminSession[])
      setUsers((userData.items || []) as AdminUser[])
      setActivity((activityData.items || []) as ActivityEvent[])
      setRetention((retentionData || null) as RetentionInfo | null)
      if (typeof policyData.fingerprint === 'string') setPolicyFingerprint(policyData.fingerprint)
      const observed = [sessionData.observed_at, activityData.observed_at, retentionData.observed_at]
        .filter((value): value is number => typeof value === 'number')
      setLastUpdated(observed.length ? Math.max(...observed) * 1000 : Date.now())
    } catch (cause) {
      setError(cause instanceof Error ? cause as RequestFailure : new Error('Admin data unavailable.'))
    } finally {
      setLoading(false)
    }
  }, [])

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

  const act = useCallback(async (path: string, body: Record<string, unknown>, message: string) => {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause as RequestFailure : new Error('Action failed.'))
    }
  }, [loadCsrf, refresh])

  const currentCount = sessions.length
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
    <div className="flex min-h-screen flex-col bg-surface-950 text-slate-200">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-surface-800 bg-surface-900 px-4 sm:px-5">
        {onClose && <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-surface-800 hover:text-slate-200" aria-label="Back to terminal"><ChevronLeft className="h-4 w-4" /></button>}
        <Shield className="h-4 w-4 text-brand-400" />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Admin Console</h1>
          <p className="text-[11px] text-slate-500">Owner-bound sessions, submitted-input metadata, and policy controls</p>
        </div>
        <span className={`hidden text-[11px] sm:inline ${stale ? 'text-amber-300' : 'text-slate-500'}`} aria-live="polite">{stale ? 'Stale' : `Updated ${lastUpdated ? age(lastUpdated / 1000) : '—'}`} · {streamState}</span>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="flex items-center gap-1.5 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-slate-400 hover:bg-surface-800 hover:text-slate-200 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-52 shrink-0 border-r border-surface-800 bg-surface-900 p-3 sm:block" aria-label="Admin views">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Operator view</p>
          {([
            ['sessions', Terminal, `Sessions (${currentCount})`],
            ['users', UserRound, 'Users & policy'],
            ['activity', Activity, 'Submitted input'],
            ['retention', CircleStop, 'Retention'],
          ] as const).map(([key, Icon, label]) => (
            <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500 hover:bg-surface-800 hover:text-slate-300'}`}><Icon className="h-3.5 w-3.5" /> {label}</button>
          ))}
          <div className="mt-6 rounded-md border border-surface-800 bg-surface-950/60 p-3 text-[11px] leading-relaxed text-slate-600">Controls are owner-bound. Interrupt is best-effort and does not guarantee remote process termination.</div>
        </nav>

        <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-6" aria-live="polite">
          <div className="mx-auto max-w-6xl">
            <div className="mb-4 flex gap-1 overflow-x-auto sm:hidden" role="tablist" aria-label="Admin views">
              {(['sessions', 'users', 'activity', 'retention'] as View[]).map(key => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`rounded-md px-3 py-1.5 text-xs capitalize ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500'}`}>{key}</button>)}
            </div>
            {notice && <div className="mb-3 flex items-center gap-2 rounded-md border border-green-900/50 bg-green-950/30 px-3 py-2 text-xs text-green-300" role="status"><Check className="h-3.5 w-3.5" /> {notice}</div>}
            {error && <div className="mb-3 flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300" role="alert"><X className="h-3.5 w-3.5" /> {error.message}</div>}
            {view === 'sessions' && <SessionsTable sessions={sessions} selected={selectedSession} onSelect={setSelectedSession} onAction={act} />}
            {view === 'users' && <UsersTable users={users} fingerprint={policyFingerprint} onAction={act} />}
            {view === 'activity' && <ActivityTable events={activity} />}
            {view === 'retention' && <RetentionPanel retention={retention} onAction={act} />}
          </div>
        </main>
      </div>
    </div>
  )
}

type Action = (path: string, body: Record<string, unknown>, message: string) => Promise<void>

function SessionsTable({ sessions, selected, onSelect, onAction }: { sessions: AdminSession[]; selected: AdminSession | null; onSelect: (session: AdminSession | null) => void; onAction: Action }) {
  return <section aria-labelledby="sessions-title">
    <div className="mb-3 flex items-end justify-between"><div><h2 id="sessions-title" className="text-base font-semibold">Session inventory</h2><p className="mt-1 text-xs text-slate-500">Active SSH channels only. Instance and generation prevent stale-target actions.</p></div><span className="text-xs text-slate-600">{sessions.length} active</span></div>
    <div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900"><table className="w-full min-w-[820px] text-left text-xs"><caption className="sr-only">Owner-bound active SSH sessions</caption><thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">Owner / target</th><th scope="col" className="px-3 py-2">State</th><th scope="col" className="px-3 py-2">Last activity</th><th scope="col" className="px-3 py-2">Identity</th><th scope="col" className="px-3 py-2 text-right">Controls</th></tr></thead><tbody>{sessions.length === 0 ? <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-600">No active sessions.</td></tr> : sessions.map(session => <tr key={session.session_instance_id} className={`border-b border-surface-800/70 last:border-0 ${selected?.session_instance_id === session.session_instance_id ? 'bg-brand-500/5' : ''}`}><td className="px-3 py-3"><div className="flex items-center gap-2 font-medium text-slate-200"><span className="h-1.5 w-1.5 rounded-full bg-green-400" />{session.owner_ldap_username || 'local'}<button type="button" className="text-left text-slate-500 underline decoration-dotted underline-offset-2 hover:text-brand-300" onClick={() => onSelect(session)}>{session.host}:{session.port}</button></div><div className="mt-1 text-[11px] text-slate-600">SSH account {session.username} · tab {session.tab_id}</div></td><td className="px-3 py-3 text-green-300">Connected</td><td className="px-3 py-3 text-slate-400">{age(session.last_activity)}</td><td className="px-3 py-3 font-mono text-[10px] text-slate-600">gen {session.generation}<br />{session.session_instance_id}</td><td className="px-3 py-3 text-right"><div className="flex justify-end gap-1.5"><button type="button" onClick={() => { const confirmation = window.prompt(`Type INTERRUPT to signal Ctrl+C to ${session.username}@${session.host}`); if (confirmation === 'INTERRUPT') void onAction(`/api/admin/sessions/${encodeURIComponent(session.session_instance_id)}/interrupt`, { generation: session.generation }, 'Interrupt queued.') }} className="rounded border border-amber-900/60 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-950/40">Interrupt</button><button type="button" onClick={() => { const confirmation = window.prompt(`Type KICK to close ${session.owner_ldap_username} ${session.host}`); if (confirmation === 'KICK') void onAction(`/api/admin/sessions/${encodeURIComponent(session.session_instance_id)}/kick`, { generation: session.generation }, 'Session closed.') }} className="rounded border border-red-900/60 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40">Kick</button></div></td></tr>)}</tbody></table></div>
    {selected && <aside className="mt-3 rounded-lg border border-brand-900/50 bg-brand-950/10 p-4" aria-label="Session details"><div className="flex items-start justify-between"><div><h3 className="text-sm font-semibold">Session details</h3><p className="mt-1 text-xs text-slate-500">Stable target identity for action confirmation.</p></div><button type="button" onClick={() => onSelect(null)} className="text-slate-500 hover:text-slate-200" aria-label="Close session details">×</button></div><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-600">Owner</dt><dd>{selected.owner_ldap_username || 'local'}</dd></div><div><dt className="text-slate-600">Target</dt><dd>{selected.host}:{selected.port}</dd></div><div><dt className="text-slate-600">SSH account</dt><dd>{selected.username}</dd></div><div><dt className="text-slate-600">Session instance</dt><dd className="font-mono text-[10px]">{selected.session_instance_id}</dd></div></dl></aside>}
  </section>
}

function UsersTable({ users, fingerprint, onAction }: { users: AdminUser[]; fingerprint: string; onAction: Action }) {
  return <section aria-labelledby="users-title"><div className="mb-3"><h2 id="users-title" className="text-base font-semibold">Users & policy</h2><p className="mt-1 text-xs text-slate-500">Allowlist changes use a fingerprinted atomic update and require restart. Disable also revokes cookies and active tabs.</p></div><div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900"><table className="w-full min-w-[620px] text-left text-xs"><caption className="sr-only">LDAP users and policy state</caption><thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">Identity</th><th scope="col" className="px-3 py-2">Active sessions</th><th scope="col" className="px-3 py-2">Policy</th><th scope="col" className="px-3 py-2 text-right">Action</th></tr></thead><tbody>{users.length === 0 ? <tr><td colSpan={4} className="px-3 py-12 text-center text-slate-600">No configured users observed.</td></tr> : users.map(user => <tr key={user.username} className="border-b border-surface-800/70 last:border-0"><td className="px-3 py-3 font-medium">{user.username}</td><td className="px-3 py-3 text-slate-400">{user.active_sessions}</td><td className="px-3 py-3 text-amber-300">{user.policy_state}</td><td className="px-3 py-3 text-right">{user.policy_state === 'pending_disable' ? <button type="button" onClick={() => void onAction(`/api/admin/users/${encodeURIComponent(user.username)}/enable`, { expected_fingerprint: fingerprint }, 'Enable queued for restart.')} className="rounded border border-green-900/60 px-2 py-1 text-[11px] text-green-300 hover:bg-green-950/40">Enable</button> : <button type="button" onClick={() => { const confirmation = window.prompt(`Type DISABLE ${user.username} to revoke this user`); if (confirmation === `DISABLE ${user.username}`) void onAction(`/api/admin/users/${encodeURIComponent(user.username)}/disable`, { expected_fingerprint: fingerprint }, 'Disable queued; active sessions revoked.') }} className="rounded border border-red-900/60 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40">Disable</button>}</td></tr>)}</tbody></table></div></section>
}

function ActivityTable({ events }: { events: ActivityEvent[] }) {
  return <section aria-labelledby="activity-title"><div className="mb-3"><h2 id="activity-title" className="text-base font-semibold">Submitted-input metadata</h2><p className="mt-1 text-xs text-slate-500">Command text and terminal bytes are never displayed here.</p></div><div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900"><table className="w-full min-w-[760px] text-left text-xs"><caption className="sr-only">Metadata for completed terminal input events</caption><thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Actor</th><th scope="col" className="px-3 py-2">Target</th><th scope="col" className="px-3 py-2">Kind</th><th scope="col" className="px-3 py-2 text-right">Bytes</th></tr></thead><tbody>{events.length === 0 ? <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-600">No submitted input events.</td></tr> : events.map(event => <tr key={event.event_id} className="border-b border-surface-800/70 last:border-0"><td className="px-3 py-3 text-slate-400">{new Date(event.occurred_at).toLocaleString()}</td><td className="px-3 py-3">{event.ldap_username}</td><td className="px-3 py-3">{event.ssh_host || '—'}:{event.ssh_port || '—'} <span className="text-slate-600">({event.ssh_username || '—'})</span></td><td className="px-3 py-3 text-slate-400">{event.kind}</td><td className="px-3 py-3 text-right text-slate-400">{event.bytes}</td></tr>)}</tbody></table></div></section>
}

function RetentionPanel({ retention, onAction }: { retention: RetentionInfo | null; onAction: Action }) {
  const [days, setDays] = useState(retention?.cutoff_days || 30)
  return <section aria-labelledby="retention-title" className="max-w-xl"><h2 id="retention-title" className="text-base font-semibold">Manual audit cleanup</h2><p className="mt-1 text-xs leading-relaxed text-slate-500">Only terminal input rows older than the cutoff are deleted. Durable admin action records remain.</p><label className="mt-5 block text-xs text-slate-400" htmlFor="retention-days">Retention age in days</label><input id="retention-days" type="number" min={7} max={3650} value={days} onChange={event => setDays(Number(event.target.value))} className="mt-1 w-32 rounded border border-surface-700 bg-surface-900 px-2 py-1.5 text-sm" /><div className="mt-4 rounded border border-surface-800 bg-surface-900 p-3 text-xs text-slate-400">Eligible rows: <strong className="text-slate-200">{retention?.eligible_count ?? '—'}</strong><br />Minimum age: {retention?.minimum_age_days ?? 7} days<br />Admin records retained: yes</div><button type="button" onClick={() => { const confirmation = window.prompt(`Type PURGE to delete terminal rows older than ${days} days`); if (confirmation === 'PURGE') void onAction('/api/admin/retention/purge', { older_than_days: days, confirmation }, 'Terminal audit rows purged; admin actions retained.') }} className="mt-4 rounded border border-red-900/60 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40">Purge eligible terminal rows</button></section>
}
