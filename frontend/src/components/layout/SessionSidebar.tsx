import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react'
import { Download, Upload, Trash2, LogIn, PanelLeftClose, PanelLeftOpen, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useTerminalStore } from '@/store/terminalStore'
import { uuid } from '@/utils/uuid'
import type { SavedServer } from '@/types'
import { useDialogPresence } from '@/hooks/useDialogPresence'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { anchoredSurface, exitTransition, fade, spatialTransition, surface, surfaceSpring } from '@/motion/tokens'

interface SessionSidebarProps {
  isOpen: boolean
  compact: boolean
  onToggle: () => void
  onLoadSession: (server: SavedServer) => void
}

const MIN_SIDEBAR_WIDTH = 208
const MAX_SIDEBAR_WIDTH = 520
const DEFAULT_SIDEBAR_WIDTH = 208
const SIDEBAR_WIDTH_KEY = 'torrus-sidebar-width'

interface ContextMenuState {
  serverId: string
  x: number
  y: number
}

function validateImportedServers(input: unknown): SavedServer[] | null {
  let data = input
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
    const port = (item as Record<string, unknown>).port as number
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
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

  const { ref: dialogRef, presenceProps } = useDialogPresence(onClose)

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

  const inputCls = 'w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors'
  const labelCls = 'text-xs text-slate-400 font-medium'

  return (
    <m.div {...fade}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <m.div {...surface} {...presenceProps} transition={surfaceSpring} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Edit Session" tabIndex={-1} className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-80 shadow-2xl flex flex-col gap-4">
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
            <div className="flex flex-col gap-1 w-24">
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
      </m.div>
    </m.div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SessionSidebar({ isOpen, compact, onToggle, onLoadSession }: SessionSidebarProps) {
  const { servers, removeServer, updateServer, importServers } = useSavedServerStore()
  const tabs = useTerminalStore(s => s.tabs)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editingServer, setEditingServer] = useState<SavedServer | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null)

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const parsed = saved ? Number(saved) : DEFAULT_SIDEBAR_WIDTH
    if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed))
  })

  // Clear selection if server is removed
  useEffect(() => {
    if (selectedId && !servers.find(s => s.id === selectedId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    resizeStartRef.current = { x: e.clientX, width: sidebarWidth }
    const onMove = (event: MouseEvent) => {
      if (!resizeStartRef.current) return
      const next = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, resizeStartRef.current.width + event.clientX - resizeStartRef.current.x)
      )
      setSidebarWidth(next)
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    }
    const onUp = () => {
      resizeStartRef.current = null
      setIsResizing(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(servers, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `torrus-sessions-${ts}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
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
    reader.onerror = () => {
      setImportError('Failed to read file.')
      setImportSuccess(false)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const isActive = (server: SavedServer) =>
    tabs.some(t =>
      t.status === 'connected' &&
      t.host === server.host &&
      t.port === server.port &&
      t.username === server.username
    )

  const selected = servers.find(s => s.id === selectedId)

  // ── Compact collapsed ────────────────────────────────────────────────────────
  if (!isOpen && compact) return null

  // ── Compact full (overlay) ──────────────────────────────────────────────────
  if (compact) {
    return (
      <>
        <m.button
          type="button"
          aria-label="Close sessions drawer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={exitTransition}
          onClick={onToggle}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px]"
        />
        <m.div
          initial={{ x: -Math.min(288, window.innerWidth - 48), opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -Math.min(288, window.innerWidth - 48), opacity: 0 }}
          transition={spatialTransition}
          style={{ width: Math.min(288, window.innerWidth - 48) }}
          className="flex min-h-0 flex-shrink-0 overflow-hidden border-r border-surface-800 fixed inset-y-0 left-0 z-40 shadow-2xl"
        >
          <SidebarInner onToggle={onToggle} servers={servers} selectedId={selectedId} setSelectedId={setSelectedId} selected={selected} isActive={isActive} handleOpen={handleOpen} handleDelete={handleDelete} handleExport={handleExport} handleImport={handleImport} setEditingServer={setEditingServer} setImportError={setImportError} importError={importError} importSuccess={importSuccess} fileInputRef={fileInputRef} contextMenu={contextMenu} setContextMenu={setContextMenu} contextMenuRef={contextMenuRef} onLoadSession={onLoadSession} removeServer={removeServer} />
        </m.div>
        <AnimatePresence>
        {contextMenu && (() => {
          const server = servers.find(s => s.id === contextMenu.serverId)
          if (!server) return null
          return (
            <m.div key="ctx" {...anchoredSurface} transition={exitTransition}
              ref={contextMenuRef}
              className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-40"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); onLoadSession(server) }}><LogIn className="w-3 h-3" /> Open</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); setEditingServer(server) }}><Pencil className="w-3 h-3" /> Edit</button>
              <div className="my-1 border-t border-surface-700" />
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); removeServer(server.id); setSelectedId(null) }}><Trash2 className="w-3 h-3" /> Delete</button>
            </m.div>
          )
        })()}
        </AnimatePresence>
        <AnimatePresence>
        {editingServer && <EditModal key="edit" server={editingServer} onSave={(updates) => updateServer(editingServer.id, updates)} onClose={() => setEditingServer(null)} />}
        </AnimatePresence>
      </>
    )
  }

  // ── Desktop — single animated div (collapsed ↔ full) ────────────────────────
  return (
    <>
      <m.div
        initial={{ width: sidebarWidth, opacity: 1 }}
        animate={{ width: isOpen ? sidebarWidth : 32, opacity: 1 }}
        transition={isResizing ? { duration: 0 } : spatialTransition}
        className="flex-shrink-0 overflow-hidden flex flex-col bg-surface-900 border-r border-surface-800 select-none relative"
      >
        {isOpen ? (
          <SidebarInner onToggle={onToggle} servers={servers} selectedId={selectedId} setSelectedId={setSelectedId} selected={selected} isActive={isActive} handleOpen={handleOpen} handleDelete={handleDelete} handleExport={handleExport} handleImport={handleImport} setEditingServer={setEditingServer} setImportError={setImportError} importError={importError} importSuccess={importSuccess} fileInputRef={fileInputRef} contextMenu={contextMenu} setContextMenu={setContextMenu} contextMenuRef={contextMenuRef} onLoadSession={onLoadSession} removeServer={removeServer} />
        ) : (
          <button
            onClick={onToggle}
            title="Show sessions"
            className="w-8 h-9 flex-shrink-0 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-b border-surface-800"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}
      </m.div>
      {!isOpen && <div
        onMouseDown={handleResizeMouseDown}
        title="Resize sessions sidebar"
        role="separator"
        aria-label="Resize sessions sidebar"
        aria-orientation="vertical"
        className="group absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-col-resize"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-brand-500" />
      </div>}
      <AnimatePresence>
      {contextMenu && (() => {
        const server = servers.find(s => s.id === contextMenu.serverId)
        if (!server) return null
        return (
          <m.div key="ctx" {...anchoredSurface} transition={exitTransition}
            ref={contextMenuRef}
            className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-40"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); onLoadSession(server) }}><LogIn className="w-3 h-3" /> Open</button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); setEditingServer(server) }}><Pencil className="w-3 h-3" /> Edit</button>
            <div className="my-1 border-t border-surface-700" />
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors" onClick={() => { setContextMenu(null); removeServer(server.id); setSelectedId(null) }}><Trash2 className="w-3 h-3" /> Delete</button>
          </m.div>
        )
      })()}
      </AnimatePresence>
      <AnimatePresence>
      {editingServer && <EditModal key="edit" server={editingServer} onSave={(updates) => updateServer(editingServer.id, updates)} onClose={() => setEditingServer(null)} />}
      </AnimatePresence>
    </>
  )
}

// ── Sidebar inner content (shared between desktop and compact) ────────────────

interface SidebarInnerProps {
  onToggle: () => void
  servers: SavedServer[]
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  selected: SavedServer | undefined
  isActive: (server: SavedServer) => boolean
  handleOpen: () => void
  handleDelete: () => void
  handleExport: () => void
  handleImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  setEditingServer: (s: SavedServer | null) => void
  setImportError: (s: string) => void
  importError: string
  importSuccess: boolean
  fileInputRef: React.RefObject<HTMLInputElement>
  contextMenu: ContextMenuState | null
  setContextMenu: (s: ContextMenuState | null) => void
  contextMenuRef: React.RefObject<HTMLDivElement>
  onLoadSession: (server: SavedServer) => void
  removeServer: (id: string) => void
}

function SidebarInner({ onToggle, servers, selectedId, setSelectedId, selected, isActive, handleOpen, handleDelete, handleExport, handleImport, setEditingServer, setImportError, importError, importSuccess, fileInputRef, onLoadSession }: SidebarInnerProps) {
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-surface-900 select-none">
      {/* Header */}
      <div className="px-3 py-2 border-b border-surface-800 flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex-1">Sessions</span>
        <button onClick={onToggle} title="Hide sessions" className="text-slate-600 hover:text-slate-400 transition-colors p-0.5">
          <PanelLeftClose className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" className="w-28 h-28 opacity-[0.04]">
            <circle cx="64" cy="64" r="54" fill="none" stroke="#16a34a" strokeWidth="3.6" />
            <circle cx="64" cy="64" r="38" fill="none" stroke="#0d9488" strokeWidth="3.2" />
            <circle cx="64" cy="64" r="22" fill="none" stroke="#10b981" strokeWidth="2.8" />
            <polyline fill="none" stroke="#0d9488" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" points="52,56 64,64 52,72" />
            <rect x="70" y="58" width="8" height="12" rx="1.5" fill="#10b981" />
          </svg>
        </div>
        {servers.length === 0 ? (
          <p className="px-3 py-4 text-xs text-slate-600 text-center leading-relaxed">No saved sessions.<br />Connect and click the bookmark icon to save one.</p>
        ) : (
          servers.map(server => (
            <div
              key={server.id}
              onClick={() => setSelectedId(server.id)}
              onDoubleClick={() => { setSelectedId(server.id); onLoadSession(server) }}
              className={clsx(
                'group flex flex-col px-3 py-2 cursor-pointer transition-colors border-l-2',
                selectedId === server.id ? 'bg-surface-800 border-l-brand-500' : 'border-l-transparent hover:bg-surface-800/50'
              )}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', { 'bg-green-400': isActive(server), 'bg-slate-600': !isActive(server) })} />
                <span className="text-xs font-medium text-slate-200 truncate flex-1">{server.name}</span>
              </div>
              <span className="text-xs text-slate-500 truncate pl-3 mt-0.5">{server.username}@{server.host}{server.port !== 22 ? `:${server.port}` : ''}</span>
            </div>
          ))
        )}
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2 px-3 py-3 border-t border-surface-800">
        <div className="flex gap-1.5">
          <button onClick={handleOpen} disabled={!selected} className={clsx('flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors', selected ? 'bg-brand-600 hover:bg-brand-500 text-white' : 'bg-surface-800 text-slate-600 cursor-not-allowed')}>
            <LogIn className="w-3 h-3" /> Open
          </button>
          <button onClick={() => { if (selected) setEditingServer(selected) }} disabled={!selected} className={clsx('flex items-center justify-center px-2 py-1.5 rounded text-xs transition-colors', selected ? 'bg-surface-800 hover:bg-surface-700 text-slate-400 hover:text-slate-200' : 'bg-surface-800 text-slate-700 cursor-not-allowed')} title="Edit session">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleDelete} disabled={!selected} className={clsx('flex items-center justify-center px-2 py-1.5 rounded text-xs transition-colors', selected ? 'bg-surface-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400' : 'bg-surface-800 text-slate-700 cursor-not-allowed')} title="Delete session">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex gap-1.5">
          <button onClick={handleExport} disabled={servers.length === 0} className={clsx('flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border transition-colors', servers.length > 0 ? 'border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800' : 'border-surface-800 text-slate-700 cursor-not-allowed')}>
            <Download className="w-3 h-3" /> Export
          </button>
          <button onClick={() => { setImportError(''); fileInputRef.current?.click() }} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800 transition-colors">
            <Upload className="w-3 h-3" /> Import
          </button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
        </div>
        {importError && <p className="text-xs text-red-400 text-center leading-tight">{importError}</p>}
        {importSuccess && <p className="text-xs text-green-400 text-center">Sessions imported.</p>}
      </div>
    </div>
  )
}
