import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react'
import { Plus, X, Pencil, Bookmark, Copy, GitFork, Settings, LogOut, PanelLeftClose } from 'lucide-react'
import clsx from 'clsx'
import { useTerminalStore } from '@/store/terminalStore'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import Logo from '@/components/ui/Logo'
import type { Tab } from '@/types'

interface TabBarProps {
  onAddTab: () => void
  onCloseTab: (id: string) => void
  onCloneTab: (id: string) => void
  onDuplicateTab: (id: string) => void
  onCloseAllTabs: () => void
  onOpenSettings: () => void
}

function StatusDot({ status }: { status: Tab['status'] }) {
  return (
    <span
      className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', {
        'bg-slate-500': status === 'disconnected',
        'bg-brand-400 animate-pulse': status === 'connecting',
        'bg-green-400': status === 'connected',
        'bg-red-400': status === 'dead',
      })}
    />
  )
}

function getTabDisplayName(tab: Tab): string {
  if (tab.label) return tab.label
  if (tab.host && tab.username) return `${tab.username}@${tab.host}`
  return 'New Connection'
}

interface ContextMenuState {
  tabId: string
  x: number
  y: number
}

interface SaveDialogState {
  tab: Tab
  name: string
}

function SaveSessionDialog({ state, onSave, onClose }: {
  state: SaveDialogState
  onSave: (name: string) => boolean
  onClose: () => void
}) {
  const [name, setName] = useState(state.name)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const ok = onSave(name.trim() || `${state.tab.username}@${state.tab.host}`)
    if (!ok) setError('This session already exists.')
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-900 border border-surface-700 rounded-xl p-5 w-72 shadow-2xl flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Bookmark className="w-4 h-4 text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-200">Save Session</h2>
        </div>
        <p className="text-xs text-slate-400">
          {state.tab.username}@{state.tab.host}{state.tab.port !== 22 ? `:${state.tab.port}` : ''}
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400 font-medium">Name</label>
            <input
              ref={inputRef}
              className="w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors"
              placeholder={`${state.tab.username}@${state.tab.host}`}
              value={name}
              onChange={e => setName(e.target.value)}
              spellCheck={false}
            />
          </div>
          {error && <p className="text-xs text-red-400 text-center">{error}</p>}
          <div className="flex gap-2">
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

export default function TabBar({ onAddTab, onCloseTab, onCloneTab, onDuplicateTab, onCloseAllTabs, onOpenSettings }: TabBarProps) {
  const { tabs, activeTabId, setActiveTab, renameTab } = useTerminalStore()
  const addServer = useSavedServerStore(s => s.addServer)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [saveDialog, setSaveDialog] = useState<SaveDialogState | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTabId])

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  const startEditing = useCallback((tab: Tab) => {
    setEditingTabId(tab.id)
    setEditValue(getTabDisplayName(tab))
    setContextMenu(null)
  }, [])

  const confirmEdit = useCallback(() => {
    if (editingTabId) {
      renameTab(editingTabId, editValue)
      setEditingTabId(null)
    }
  }, [editingTabId, editValue, renameTab])

  const cancelEdit = useCallback(() => {
    setEditingTabId(null)
  }, [])

  return (
    <>
    <div className="h-9 flex-shrink-0 flex items-stretch bg-surface-900 border-b border-surface-800 overflow-x-auto overflow-y-hidden">
      {/* Logo branding */}
      <div className="flex-shrink-0 flex items-center px-3 border-r border-surface-800">
        <Logo size="sm" showText={true} />
      </div>

      {/* New tab button */}
      <button
        onClick={onAddTab}
        title="New tab (Ctrl+T)"
        className="flex-shrink-0 w-9 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-r border-surface-800"
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* Tab buttons */}
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
          }}
          className={clsx(
            'group flex items-center gap-2 px-3 min-w-32 max-w-48 border-r border-surface-800 transition-colors text-xs font-mono',
            activeTabId === tab.id
              ? 'bg-surface-950 text-slate-200 border-b-2 border-b-brand-500'
              : 'text-slate-500 hover:text-slate-300 hover:bg-surface-800'
          )}
        >
          <StatusDot status={tab.status} />

          {editingTabId === tab.id ? (
            <input
              ref={editInputRef}
              className="flex-1 bg-transparent border-b border-brand-500 outline-none text-xs font-mono text-slate-200 min-w-0"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmEdit()
                if (e.key === 'Escape') cancelEdit()
              }}
              onBlur={confirmEdit}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className="flex-1 truncate text-left"
              onDoubleClick={(e) => {
                e.stopPropagation()
                startEditing(tab)
              }}
            >
              {getTabDisplayName(tab)}
            </span>
          )}

          <button
            onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
            className="flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity p-0.5 rounded"
            title="Close tab"
          >
            <X className="w-3 h-3" />
          </button>
        </button>
      ))}

      {/* Spacer + Close All + Settings + Logout */}
      <div className="flex-1" />
      {tabs.length > 1 && (
        <button
          onClick={onCloseAllTabs}
          title="Close all tabs"
          className="flex-shrink-0 flex items-center gap-1 px-3 text-xs text-slate-500 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800 h-full"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
          Close All
        </button>
      )}
      <button
        onClick={onOpenSettings}
        title="Settings (Ctrl+,)"
        className="flex-shrink-0 w-9 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-l border-surface-800"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>
      {ldapEnabled && (
        <button
          onClick={() => { window.location.href = '/_auth/logout' }}
          title="Logout"
          className="flex-shrink-0 w-9 flex items-center justify-center text-red-500 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Context menu */}
      {contextMenu && (() => {
        const tab = tabs.find(t => t.id === contextMenu.tabId)
        if (!tab) return null
        return (
          <div
            ref={contextMenuRef}
            className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-36"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
              onClick={() => startEditing(tab)}
            >
              <Pencil className="w-3 h-3" />
              Rename
            </button>
            {tab.status === 'connected' && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); onCloneTab(tab.id) }}
              >
                <GitFork className="w-3 h-3" />
                Clone (same connection)
              </button>
            )}
            {tab.host && tab.username && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); onDuplicateTab(tab.id) }}
              >
                <Copy className="w-3 h-3" />
                Duplicate (new connection)
              </button>
            )}
            {tab.host && tab.username && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => {
                  setContextMenu(null)
                  setSaveDialog({
                    tab,
                    name: tab.label ?? `${tab.username}@${tab.host}`,
                  })
                }}
              >
                <Bookmark className="w-3 h-3" />
                Save to sessions
              </button>
            )}
            <div className="my-1 border-t border-surface-700" />
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors"
              onClick={() => { setContextMenu(null); onCloseTab(tab.id) }}
            >
              <X className="w-3 h-3" />
              Close
            </button>
          </div>
        )
      })()}

    </div>

    {/* Save session dialog — rendered outside the overflow-hidden TabBar */}
    {saveDialog && (
      <SaveSessionDialog
        state={saveDialog}
        onSave={(name) => {
          const ok = addServer({
            name,
            host: saveDialog.tab.host!,
            port: saveDialog.tab.port ?? 22,
            username: saveDialog.tab.username!,
          })
          if (ok) setSaveDialog(null)
          return ok
        }}
        onClose={() => setSaveDialog(null)}
      />
    )}
    </>
  )
}
