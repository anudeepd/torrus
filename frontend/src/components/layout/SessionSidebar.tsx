import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react'
import { Download, Upload, Trash2, LogIn, PanelLeftClose, PanelLeftOpen, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useTerminalStore } from '@/store/terminalStore'
import type { SavedServer } from '@/types'

interface SessionSidebarProps {
  isOpen: boolean
  onToggle: () => void
  onLoadSession: (server: SavedServer) => void
}

interface ContextMenuState {
  serverId: string
  x: number
  y: number
}

function uuid() {
  return crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
}

function validateImportedServers(data: unknown): SavedServer[] | null {
  if (!Array.isArray(data)) {
    if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).servers)) {
      data = (data as Record<string, unknown>).servers
    } else {
      return null
    }
  }
  const result: SavedServer[] = []
  for (const item of data as unknown[]) {
    if (
      typeof item !== 'object' || item === null ||
      typeof (item as Record<string, unknown>).name !== 'string' ||
      typeof (item as Record<string, unknown>).host !== 'string' ||
      typeof (item as Record<string, unknown>).port !== 'number' ||
      typeof (item as Record<string, unknown>).username !== 'string'
    ) return null
    const s = item as SavedServer
    result.push({ id: uuid(), name: s.name, host: s.host, port: s.port, username: s.username })
  }
  return result
}

// ── Edit modal ───────────────────────────────────────────────────────────────

interface EditModalProps {
  server: SavedServer
  onSave: (updates: Omit<SavedServer, 'id'>) => boolean
  onClose: () => void
}

function EditModal({ server, onSave, onClose }: EditModalProps) {
  const [name, setName] = useState(server.name)
  const [host, setHost] = useState(server.host)
  const [port, setPort] = useState(server.port.toString())
  const [username, setUsername] = useState(server.username)
  const [error, setError] = useState('')

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!host.trim()) { setError('Host is required.'); return }
    if (!username.trim()) { setError('Username is required.'); return }
    const parsedPort = parseInt(port, 10)
    if (!parsedPort || parsedPort < 1 || parsedPort > 65535) { setError('Port must be 1–65535.'); return }

    const ok = onSave({
      name: name.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: parsedPort,
      username: username.trim(),
    })
    if (!ok) {
      setError('A session with that host, port, and username already exists.')
      return
    }
    onClose()
  }

  const inputCls = 'w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors'
  const labelCls = 'text-xs text-slate-400 font-medium'

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-80 shadow-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Pencil className="w-4 h-4 text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-200">Edit Session</h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className={labelCls}>Name</label>
            <input
              className={inputCls}
              placeholder={`${username || 'user'}@${host || 'host'}`}
              value={name}
              onChange={e => setName(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <label className={labelCls}>Host</label>
              <input
                className={inputCls}
                placeholder="hostname or IP"
                value={host}
                onChange={e => setHost(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1 w-20">
              <label className={labelCls}>Port</label>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelCls}>Username</label>
            <input
              className={inputCls}
              placeholder="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              spellCheck={false}
              autoComplete="username"
            />
          </div>

          {error && <p className="text-xs text-red-400 text-center">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SessionSidebar({ isOpen, onToggle, onLoadSession }: SessionSidebarProps) {
  const { servers, removeServer, updateServer, importServers } = useSavedServerStore()
  const tabs = useTerminalStore(s => s.tabs)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editingServer, setEditingServer] = useState<SavedServer | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Clear selection if server is removed
  useEffect(() => {
    if (selectedId && !servers.find(s => s.id === selectedId)) {
      setSelectedId(null)
    }
  }, [servers, selectedId])

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const onMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  const handleDelete = useCallback(() => {
    if (!selectedId) return
    removeServer(selectedId)
    setSelectedId(null)
  }, [selectedId, removeServer])

  const handleOpen = useCallback(() => {
    const server = servers.find(s => s.id === selectedId)
    if (server) onLoadSession(server)
  }, [selectedId, servers, onLoadSession])

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(servers, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `torrus-sessions-${ts}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string)
        const validated = validateImportedServers(parsed)
        if (!validated) {
          setImportError('Invalid file — expected an array of sessions.')
          setImportSuccess(false)
          return
        }
        importServers(validated, 'merge')
        setImportError('')
        setImportSuccess(true)
        setTimeout(() => setImportSuccess(false), 2500)
      } catch {
        setImportError('Could not parse JSON file.')
        setImportSuccess(false)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const isActive = (server: SavedServer) =>
    tabs.some(t => t.status === 'connected' && t.host === server.host && t.username === server.username)

  const selected = servers.find(s => s.id === selectedId)

  // ── Collapsed state ──────────────────────────────────────────────────────────
  if (!isOpen) {
    return (
      <div className="w-8 flex-shrink-0 flex flex-col items-center bg-surface-900 border-r border-surface-800 select-none">
        <button
          onClick={onToggle}
          title="Show sessions"
          className="w-full h-9 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-b border-surface-800"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </div>
    )
  }

  // ── Full sidebar ─────────────────────────────────────────────────────────────
  return (
    <>
      <div className="w-52 flex-shrink-0 flex flex-col bg-surface-900 border-r border-surface-800 select-none">
        {/* Header */}
        <div className="px-3 py-2 border-b border-surface-800 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex-1">Sessions</span>
          <button
            onClick={onToggle}
            title="Hide sessions"
            className="text-slate-600 hover:text-slate-400 transition-colors p-0.5"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto py-1">
          {servers.length === 0 ? (
            <p className="px-3 py-4 text-xs text-slate-600 text-center leading-relaxed">
              No saved sessions.<br />
              Connect and click the bookmark icon to save one.
            </p>
          ) : (
            servers.map(server => (
              <div
                key={server.id}
                onClick={() => setSelectedId(server.id)}
                onDoubleClick={() => { setSelectedId(server.id); onLoadSession(server) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelectedId(server.id)
                  setContextMenu({ serverId: server.id, x: e.clientX, y: e.clientY })
                }}
                className={clsx(
                  'group flex flex-col px-3 py-2 cursor-pointer transition-colors border-l-2',
                  selectedId === server.id
                    ? 'bg-surface-800 border-l-brand-500'
                    : 'border-l-transparent hover:bg-surface-800/50'
                )}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', {
                    'bg-green-400': isActive(server),
                    'bg-slate-600': !isActive(server),
                  })} />
                  <span className="text-xs font-medium text-slate-200 truncate flex-1">
                    {server.name}
                  </span>
                </div>
                <span className="text-xs text-slate-500 truncate pl-3 mt-0.5">
                  {server.username}@{server.host}{server.port !== 22 ? `:${server.port}` : ''}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2 px-3 py-3 border-t border-surface-800">
          <div className="flex gap-1.5">
            <button
              onClick={handleOpen}
              disabled={!selected}
              className={clsx(
                'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors',
                selected
                  ? 'bg-brand-600 hover:bg-brand-500 text-white'
                  : 'bg-surface-800 text-slate-600 cursor-not-allowed'
              )}
            >
              <LogIn className="w-3 h-3" />
              Open
            </button>
            <button
              onClick={() => { if (selected) setEditingServer(selected) }}
              disabled={!selected}
              className={clsx(
                'flex items-center justify-center px-2 py-1.5 rounded text-xs transition-colors',
                selected
                  ? 'bg-surface-800 hover:bg-surface-700 text-slate-400 hover:text-slate-200'
                  : 'bg-surface-800 text-slate-700 cursor-not-allowed'
              )}
              title="Edit session"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleDelete}
              disabled={!selected}
              className={clsx(
                'flex items-center justify-center px-2 py-1.5 rounded text-xs transition-colors',
                selected
                  ? 'bg-surface-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400'
                  : 'bg-surface-800 text-slate-700 cursor-not-allowed'
              )}
              title="Delete session"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={handleExport}
              disabled={servers.length === 0}
              className={clsx(
                'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border transition-colors',
                servers.length > 0
                  ? 'border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800'
                  : 'border-surface-800 text-slate-700 cursor-not-allowed'
              )}
            >
              <Download className="w-3 h-3" />
              Export
            </button>
            <button
              onClick={() => { setImportError(''); fileInputRef.current?.click() }}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800 transition-colors"
            >
              <Upload className="w-3 h-3" />
              Import
            </button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
          </div>

          {importError && <p className="text-xs text-red-400 text-center leading-tight">{importError}</p>}
          {importSuccess && <p className="text-xs text-green-400 text-center">Sessions imported.</p>}
        </div>
      </div>

      {/* Right-click context menu */}
      {contextMenu && (() => {
        const server = servers.find(s => s.id === contextMenu.serverId)
        if (!server) return null
        return (
          <div
            ref={contextMenuRef}
            className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-40"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
              onClick={() => { setContextMenu(null); onLoadSession(server) }}
            >
              <LogIn className="w-3 h-3" />
              Open
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
              onClick={() => { setContextMenu(null); setEditingServer(server) }}
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
            <div className="my-1 border-t border-surface-700" />
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors"
              onClick={() => { setContextMenu(null); removeServer(server.id); setSelectedId(null) }}
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          </div>
        )
      })()}

      {/* Edit modal */}
      {editingServer && (
        <EditModal
          server={editingServer}
          onSave={(updates) => updateServer(editingServer.id, updates)}
          onClose={() => setEditingServer(null)}
        />
      )}
    </>
  )
}
