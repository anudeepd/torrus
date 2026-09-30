import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react'
import { Download, Upload, Trash2, LogIn, PanelLeftClose, PanelLeftOpen, Pencil } from 'lucide-react'
import { cn } from '@/lib/cn'
import Dialog from '@/components/ui/Dialog'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useTerminalStore } from '@/store/terminalStore'
import { uuid } from '@/utils/uuid'
import type { SavedServer } from '@/types'
import { handleMenuKeyDown } from '@/lib/menuKeys'
import { useDismissLayer } from '@/lib/dismissLayers'
import { AnimatePresence, useIsPresent } from 'motion/react'
import * as m from 'motion/react-m'
import { anchoredSurface, exitTransition, fade, spatialTransition, surfaceTransition } from '@/motion/tokens'

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
const KEYBOARD_RESIZE_STEP = 16

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

  const inputCls = 'w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus:border-brand-500 transition-colors'
  const labelCls = 'text-xs text-slate-400 font-medium'

  return (
    <Dialog label="Edit session" onClose={onClose} className="w-80 gap-4">
        <div className="flex items-center gap-2">
          <Pencil className="size-4 text-brand-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-200 text-balance">Edit session</h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="edit-session-name" className={labelCls}>Name</label>
            <input
              id="edit-session-name"
              name="name"
              className={inputCls}
              placeholder={`${username || 'user'}@${host || 'host'}…`}
              value={name}
              onChange={e => setName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <label htmlFor="edit-session-host" className={labelCls}>Host</label>
              <input
                id="edit-session-host"
                name="host"
                className={inputCls}
                placeholder="hostname or IP…"
                value={host}
                onChange={e => setHost(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1 w-24">
              <label htmlFor="edit-session-port" className={labelCls}>Port</label>
              <input
                id="edit-session-port"
                name="port"
                className={inputCls}
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={port}
                onChange={e => setPort(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="edit-session-username" className={labelCls}>Username</label>
            <input
              id="edit-session-username"
              name="username"
              className={inputCls}
              placeholder="username…"
              value={username}
              onChange={e => setUsername(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <AnimatePresence initial={false}>
            {error && <m.p role="alert" {...fade} transition={exitTransition} className="text-xs text-red-400 text-center text-pretty">{error}</m.p>}
          </AnimatePresence>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-brand-700 hover:bg-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Save
            </button>
          </div>
        </form>
    </Dialog>
  )
}

// ── Delete confirmation ──────────────────────────────────────────────────────

interface DeleteSessionDialogProps {
  server: SavedServer
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Removing a saved session cannot be undone, so every delete goes through this
 * one `alertdialog` — the toolbar button, the row's context menu, and the
 * keyboard path. Mounted with the server id as its key, so a second delete
 * starts from a clean state instead of reusing the first one's.
 */
function DeleteSessionDialog({ server, onCancel, onConfirm }: DeleteSessionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog role="alertdialog" layer="confirm" label="Delete session" initialFocus={cancelRef} onClose={onCancel} className="w-80 gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-200 text-balance">Delete session?</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400 text-pretty">
            {server.name} ({server.username}@{server.host}) will be removed from your saved sessions. This cannot be undone.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md bg-surface-800 px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-surface-700 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Delete
          </button>
        </div>
    </Dialog>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SessionSidebar({ isOpen, compact, onToggle, onLoadSession }: SessionSidebarProps) {
  const isPresent = useIsPresent()
  const servers = useSavedServerStore(s => s.servers)
  const removeServer = useSavedServerStore(s => s.removeServer)
  const updateServer = useSavedServerStore(s => s.updateServer)
  const importServers = useSavedServerStore(s => s.importServers)
  const tabs = useTerminalStore(s => s.tabs)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SavedServer | null>(null)
  const [editingServer, setEditingServer] = useState<SavedServer | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null)

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const parsed = saved ? Number(saved) : DEFAULT_SIDEBAR_WIDTH
    if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed))
  })

  useDismissLayer(!!contextMenu, () => setContextMenu(null))

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const onMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    // Take focus so Escape and the arrow keys reach the menu instead of xterm.
    contextMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [contextMenu])

  // Every delete entry point asks here first; the dialog does the removing.
  const handleDelete = useCallback(() => {
    const server = servers.find(s => s.id === selectedId)
    if (server) setPendingDelete(server)
  }, [selectedId, servers])

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return
    removeServer(pendingDelete.id)
    setSelectedId(null)
    setPendingDelete(null)
  }, [pendingDelete, removeServer])

  const handleOpen = useCallback(() => {
    const server = servers.find(s => s.id === selectedId)
    if (server) onLoadSession(server)
  }, [selectedId, servers, onLoadSession])

  const applySidebarWidth = useCallback((next: number) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, next))
    setSidebarWidth(clamped)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped))
  }, [])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizeStartRef.current = { x: e.clientX, width: sidebarWidth }
    const onMove = (event: MouseEvent) => {
      if (!resizeStartRef.current) return
      applySidebarWidth(resizeStartRef.current.width + event.clientX - resizeStartRef.current.x)
    }
    const onUp = () => {
      resizeStartRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [applySidebarWidth, sidebarWidth])

  // WCAG 2.5.7: the handle is also a window splitter, so resizing is reachable
  // without a pointer.
  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      applySidebarWidth(event.key === 'Home' ? MIN_SIDEBAR_WIDTH : MAX_SIDEBAR_WIDTH)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    applySidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP))
  }, [applySidebarWidth, sidebarWidth])

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

  // Derived: a server removed from the store (or replaced by an import) can
  // never leave a stale selection behind, and the id is only ever compared
  // against existing servers.
  const selected = servers.find(s => s.id === selectedId)

  // ── Compact collapsed ────────────────────────────────────────────────────────
  // Still render while a parent AnimatePresence plays the exit (`isPresent` is
  // false exactly then), so closing the drawer animates instead of snapping.
  if (!isOpen && compact && isPresent) return null

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
          className="fixed inset-0 z-menu bg-black/60"
        />
        <m.div
          initial={{ x: -Math.min(288, window.innerWidth - 48), opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -Math.min(288, window.innerWidth - 48), opacity: 0 }}
          transition={spatialTransition}
          style={{ width: Math.min(288, window.innerWidth - 48) }}
          className="flex min-h-0 flex-shrink-0 overflow-hidden border-r border-surface-800 fixed inset-y-0 left-0 z-menu pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
        >
          <SidebarInner onToggle={onToggle} servers={servers} selectedId={selectedId} setSelectedId={setSelectedId} selected={selected} isActive={isActive} handleOpen={handleOpen} handleDelete={handleDelete} handleExport={handleExport} handleImport={handleImport} setEditingServer={setEditingServer} setImportError={setImportError} importError={importError} importSuccess={importSuccess} fileInputRef={fileInputRef} setContextMenu={setContextMenu} onLoadSession={onLoadSession} />
        </m.div>
        <AnimatePresence>
        {contextMenu && (() => {
          const server = servers.find(s => s.id === contextMenu.serverId)
          if (!server) return null
          return (
            <m.div key="ctx" {...anchoredSurface} transition={exitTransition}
              ref={contextMenuRef}
              role="menu" aria-label="Session actions"
              onKeyDown={event => handleMenuKeyDown(event, contextMenuRef.current, () => setContextMenu(null))} className="fixed z-menu bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-40"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); onLoadSession(server) }}><LogIn className="size-3" aria-hidden="true" /> Open</button>
              <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); setEditingServer(server) }}><Pencil className="size-3" aria-hidden="true" /> Edit</button>
              <div className="my-1 border-t border-surface-700" />
              <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); setPendingDelete(server) }}><Trash2 className="size-3" aria-hidden="true" /> Delete</button>
            </m.div>
          )
        })()}
        </AnimatePresence>
        <AnimatePresence>
        {editingServer && <EditModal key="edit" server={editingServer} onSave={(updates) => updateServer(editingServer.id, updates)} onClose={() => setEditingServer(null)} />}
        </AnimatePresence>
        <AnimatePresence>
        {pendingDelete && <DeleteSessionDialog key={pendingDelete.id} server={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
        </AnimatePresence>
      </>
    )
  }

  // ── Desktop — the rail swaps its width instantly (animating `width`
  // re-laid-out the whole shell every frame) and the panel inside it slides and
  // fades on the compositor instead. ─────────────────────────────────────────
  return (
    <>
      <div
        className="flex-shrink-0 overflow-hidden flex flex-col bg-surface-900 border-r border-surface-800 select-none relative"
        style={{ width: isOpen ? sidebarWidth : 32 }}
      >
        {isOpen ? (
          <m.div
            initial={{ x: -16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={surfaceTransition}
            className="flex min-h-0 flex-1 flex-col"
            style={{ width: sidebarWidth }}
          >
            <SidebarInner onToggle={onToggle} servers={servers} selectedId={selectedId} setSelectedId={setSelectedId} selected={selected} isActive={isActive} handleOpen={handleOpen} handleDelete={handleDelete} handleExport={handleExport} handleImport={handleImport} setEditingServer={setEditingServer} setImportError={setImportError} importError={importError} importSuccess={importSuccess} fileInputRef={fileInputRef} setContextMenu={setContextMenu} onLoadSession={onLoadSession} />
          </m.div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            title="Show sessions"
            aria-label="Show sessions"
            className="w-8 h-9 flex-shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-300 hover:bg-surface-800 transition-colors border-b border-surface-800"
          >
            <PanelLeftOpen className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {!isOpen && <div
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
        title="Resize sessions sidebar"
        role="separator"
        aria-label="Resize sessions sidebar"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        className="group absolute inset-y-0 right-0 z-rail w-2 translate-x-1/2 cursor-col-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
            role="menu" aria-label="Session actions"
            onKeyDown={event => handleMenuKeyDown(event, contextMenuRef.current, () => setContextMenu(null))} className="fixed z-menu bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-40"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); onLoadSession(server) }}><LogIn className="size-3" aria-hidden="true" /> Open</button>
            <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); setEditingServer(server) }}><Pencil className="size-3" aria-hidden="true" /> Edit</button>
            <div className="my-1 border-t border-surface-700" />
            <button type="button" role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500" onClick={() => { setContextMenu(null); setPendingDelete(server) }}><Trash2 className="size-3" aria-hidden="true" /> Delete</button>
          </m.div>
        )
      })()}
      </AnimatePresence>
      <AnimatePresence>
      {editingServer && <EditModal key="edit" server={editingServer} onSave={(updates) => updateServer(editingServer.id, updates)} onClose={() => setEditingServer(null)} />}
      </AnimatePresence>
      <AnimatePresence>
      {pendingDelete && <DeleteSessionDialog key={pendingDelete.id} server={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
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
  setContextMenu: (s: ContextMenuState | null) => void
  onLoadSession: (server: SavedServer) => void
}

function SidebarInner({ onToggle, servers, selectedId, setSelectedId, selected, isActive, handleOpen, handleDelete, handleExport, handleImport, setEditingServer, setImportError, importError, importSuccess, fileInputRef, setContextMenu, onLoadSession }: SidebarInnerProps) {
  return (
    <nav aria-label="Saved sessions" className="flex-1 min-w-0 flex flex-col bg-surface-900 select-none">
      {/* Header */}
      <div className="px-3 py-2 border-b border-surface-800 flex items-center gap-2">
        <h2 className="text-xs font-semibold text-slate-400 flex-1 text-balance">Sessions</h2>
        <button
          type="button"
          onClick={onToggle}
          title="Hide sessions"
          aria-label="Hide sessions"
          className="flex size-6 flex-shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <PanelLeftClose className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-1 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="size-28 opacity-[0.04]">
            <circle cx="64" cy="64" r="54" fill="none" stroke="#16a34a" strokeWidth="3.6" />
            <circle cx="64" cy="64" r="38" fill="none" stroke="#0d9488" strokeWidth="3.2" />
            <circle cx="64" cy="64" r="22" fill="none" stroke="#10b981" strokeWidth="2.8" />
            <polyline fill="none" stroke="#0d9488" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" points="52,56 64,64 52,72" />
            <rect x="70" y="58" width="8" height="12" rx="1.5" fill="#10b981" />
          </svg>
        </div>
        <AnimatePresence initial={false}>
        {servers.length === 0 ? (
          <m.p key="no-servers" {...fade} transition={exitTransition} className="px-3 py-4 text-xs text-slate-400 text-center leading-relaxed text-pretty">No saved sessions.<br />Connect and click the bookmark icon to save one.</m.p>
        ) : (
          servers.map(server => (
            <m.button
              key={server.id}
              type="button"
              {...fade}
              transition={exitTransition}
              onClick={() => setSelectedId(server.id)}
              onDoubleClick={() => { setSelectedId(server.id); onLoadSession(server) }}
              onContextMenu={event => {
                event.preventDefault()
                setSelectedId(server.id)
                setContextMenu({ serverId: server.id, x: event.clientX, y: event.clientY })
              }}
              onKeyDown={event => {
                // Shift+F10 / the Menu key open the same menu as right-click.
                if (!((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                setSelectedId(server.id)
                setContextMenu({ serverId: server.id, x: rect.left, y: rect.bottom })
              }}
              className={cn(
                'group flex w-full flex-col px-3 py-2 text-left cursor-pointer transition-colors border-l-2',
                '[content-visibility:auto] [contain-intrinsic-size:auto_2.125rem]',
                selectedId === server.id ? 'bg-surface-800 border-l-brand-500' : 'border-l-transparent hover:bg-surface-800/50'
              )}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn('size-1.5 rounded-full flex-shrink-0', { 'bg-green-400': isActive(server), 'bg-slate-600': !isActive(server) })} />
                <span className="text-xs font-medium text-slate-200 truncate flex-1">{server.name}</span>
              </div>
              <span className="text-xs text-slate-400 truncate pl-3 mt-0.5 tabular-nums">{server.username}@{server.host}{server.port !== 22 ? `:${server.port}` : ''}</span>
            </m.button>
          ))
        )}
        </AnimatePresence>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2 px-3 py-3 border-t border-surface-800">
        <div className="flex gap-1.5">
          <button type="button" onClick={handleOpen} disabled={!selected} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 bg-brand-700 hover:bg-brand-600 text-white">
            <LogIn className="size-3" aria-hidden="true" /> Open
          </button>
          <button type="button" onClick={() => { if (selected) setEditingServer(selected) }} disabled={!selected} aria-label="Edit session" className="flex items-center justify-center px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 bg-surface-800 hover:bg-surface-700 text-slate-400 hover:text-slate-200" title="Edit session">
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={handleDelete} disabled={!selected} aria-label="Delete session" className="flex items-center justify-center px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 bg-surface-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400" title="Delete session">
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={handleExport} disabled={servers.length === 0} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 border border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800">
            <Download className="size-3" aria-hidden="true" /> Export
          </button>
          <button type="button" onClick={() => { setImportError(''); fileInputRef.current?.click() }} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 border border-surface-700 text-slate-400 hover:text-slate-200 hover:border-surface-600 hover:bg-surface-800">
            <Upload className="size-3" aria-hidden="true" /> Import
          </button>
          <input ref={fileInputRef} type="file" accept=".json" name="sessions-file" aria-label="Import sessions file" autoComplete="off" className="hidden" onChange={handleImport} />
        </div>
        <AnimatePresence initial={false}>
          {importError && <m.p key="import-error" role="alert" {...fade} transition={exitTransition} className="text-xs text-red-400 text-center leading-tight text-pretty">{importError}</m.p>}
          {importSuccess && <m.p key="import-success" role="status" {...fade} transition={exitTransition} className="text-xs text-green-400 text-center text-pretty">Sessions imported.</m.p>}
        </AnimatePresence>
      </div>
    </nav>
  )
}
