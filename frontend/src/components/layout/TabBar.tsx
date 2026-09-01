import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type FormEvent } from 'react'
import { Plus, X, Pencil, Bookmark, Copy, Folder, GitFork, Settings, LogOut, Menu, PanelLeftClose, Radio, Columns2, Command, Shield } from 'lucide-react'
import clsx from 'clsx'
import { useTerminalStore } from '@/store/terminalStore'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import Logo from '@/components/ui/Logo'
import type { Tab } from '@/types'
import { modKey } from '@/utils/platform'
import { submitLdapLogout } from '@/utils/authRedirect'
import { useModalFocus } from '@/hooks/useModalFocus'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { anchoredSurface, exitTransition, surfaceSpring } from '@/motion/tokens'

interface TabBarProps {
  onAddTab: () => void
  onCloseTab: (id: string) => void
  onCloneTab: (id: string) => void
  onOpenSftpTab: (id: string) => void
  onDuplicateTab: (id: string) => void
  onCloseAllTabs: () => void
  onOpenSettings: () => void
  onOpenAdmin?: () => void
  onOpenSplitPicker: () => void
  onOpenBroadcastPicker: () => void
  onExitSplit: () => void
  onSetActiveTab: (id: string) => void
  inSplitMode: boolean
  compactSidebar?: boolean
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  onOpenCommandPalette?: () => void
}

function submitLogout() {
  localStorage.removeItem('torrus_session_id')
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/_auth/logout'
  document.body.appendChild(form)
  submitLdapLogout(form)
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
  if (tab.type === 'sftp') return 'SFTP'
  if (tab.host && tab.username) return `${tab.username}@${tab.host}`
  return 'New Connection'
}

function getTabTitle(tab: Tab): string {
  const displayName = getTabDisplayName(tab)
  if (tab.host && tab.username) {
    return `${displayName} (${tab.username}@${tab.host}${tab.port ? `:${tab.port}` : ''})`
  }
  return `${displayName} tab`
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

  const dialogRef = useModalFocus(true, onClose, inputRef)

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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Save Session" tabIndex={-1} className="bg-surface-900 border border-surface-700 rounded-xl p-5 w-72 shadow-2xl flex flex-col gap-3">
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

export default function TabBar({ onAddTab, onCloseTab, onCloneTab, onOpenSftpTab, onDuplicateTab, onCloseAllTabs, onOpenSettings, onOpenAdmin, onOpenSplitPicker, onOpenBroadcastPicker, onExitSplit, onSetActiveTab, inSplitMode, compactSidebar = false, sidebarOpen = false, onToggleSidebar, onOpenCommandPalette }: TabBarProps) {
  const { tabs, activeTabId, renameTab, moveTab } = useTerminalStore()
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const addServer = useSavedServerStore(s => s.addServer)
  const { ldapEnabled, isAdmin } = useServerConfigStore()
  const { enabled: broadcastEnabled } = useBroadcastStore()
  const connectedCount = useMemo(() => tabs.filter(t => t.type === 'terminal' && t.status === 'connected').length, [tabs])
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [saveDialog, setSaveDialog] = useState<SaveDialogState | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const tabListRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const tab = activeTabId ? tabRefs.current[activeTabId]?.parentElement : null
    const tabList = tabListRef.current
    if (!tab || !tabList) return

    const frame = window.requestAnimationFrame(() => {
      const tabRect = tab.getBoundingClientRect()
      const tabListRect = tabList.getBoundingClientRect()
      if (tabRect.left < tabListRect.left) {
        tabList.scrollLeft += tabRect.left - tabListRect.left
      } else if (tabRect.right > tabListRect.right) {
        tabList.scrollLeft += tabRect.right - tabListRect.right
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length])

  // Reset save dialog if its tab is closed
  useEffect(() => {
    if (saveDialog && !tabs.find(t => t.id === saveDialog.tab.id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSaveDialog(null)
    }
  }, [tabs, saveDialog])

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

  const handleEditBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related === null || related?.dataset?.tabId) {
      cancelEdit()
    } else {
      confirmEdit()
    }
  }, [confirmEdit, cancelEdit])

  return (
    <>
    <div className={clsx('flex-shrink-0 bg-surface-900 border-b border-surface-800', compactSidebar ? 'grid h-[92px] grid-cols-[40px_minmax(0,1fr)_40px] grid-rows-[46px_46px]' : 'h-[46px] flex items-center')}>
      {compactSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          aria-label={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          aria-expanded={sidebarOpen}
          className="col-start-1 row-start-1 h-[46px] w-10 flex-shrink-0 flex items-center justify-center text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200"
        >
          <Menu className="h-4 w-4" />
        </button>
      )}
      {/* Logo branding */}
      <div className={clsx('h-10 flex-shrink-0 flex items-center px-3 border-r border-surface-800', compactSidebar ? 'col-start-2 row-start-1 self-center border-r-0 px-2 [&>div>span]:inline' : 'max-[800px]:w-10 max-[800px]:justify-center max-[800px]:px-2 max-[800px]:[&>div>span]:hidden')}>
        <Logo size="sm" showText={true} />
      </div>

      {compactSidebar && (
        <button type="button" onClick={onOpenCommandPalette} title="Open command palette" aria-label="Open command palette" className="col-start-3 row-start-1 flex h-[46px] w-10 justify-self-end items-center justify-center text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200">
          <Command className="h-4 w-4" />
        </button>
      )}

      {/* New tab button */}
      <button
        onClick={onAddTab}
        title="New tab"
        className={clsx('h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-r border-surface-800', compactSidebar && 'col-start-1 row-start-2 self-center')}
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* Tab buttons */}
      <div className={clsx('flex-1 h-full min-w-0 overflow-hidden', compactSidebar && 'col-start-2 row-start-2', compactSidebar && inSplitMode && 'col-end-4')}>
        <div ref={tabListRef} className="torrus-tab-strip flex h-full items-center flex-nowrap overflow-x-scroll overflow-y-hidden" role="tablist" aria-label="Sessions">
          <AnimatePresence initial={false}>
          {tabs.map(tab => (
            <m.div
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: draggedTabId === tab.id ? 0.5 : 1, x: 0 }}
              exit={{ opacity: 0, x: -14 }}
              transition={surfaceSpring}
              key={tab.id}
              draggable
              onDragStart={(e) => {
                const event = e as unknown as React.DragEvent
                setDraggedTabId(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (draggedTabId && draggedTabId !== tab.id) moveTab(draggedTabId, tab.id)
                setDraggedTabId(null)
              }}
              onDragEnd={() => setDraggedTabId(null)}
              onMouseDown={(e) => {
                if (e.button === 2) e.preventDefault()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              className={clsx(
                'relative group h-[40px] flex flex-shrink-0 select-none items-center min-w-32 max-w-48 border-r border-surface-800 whitespace-nowrap transition-colors text-xs font-mono max-[600px]:min-w-28 max-[600px]:max-w-36',
                activeTabId === tab.id
                  ? 'bg-surface-950 text-slate-200'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-surface-800'
              )}
            >
              {activeTabId === tab.id && (
                <m.span initial={{ opacity: 0, scaleX: 0.65 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-x-0 top-0 h-0.5 origin-center bg-brand-500" />
              )}
              {editingTabId === tab.id ? (
                <input
                  ref={editInputRef}
                  className="ml-3 min-w-0 flex-1 bg-transparent border-b border-brand-500 outline-none text-xs font-mono text-slate-200"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') confirmEdit()
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  onBlur={handleEditBlur}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <button
                  ref={(element) => { tabRefs.current[tab.id] = element }}
                  type="button"
                  role="tab"
                  aria-selected={activeTabId === tab.id}
                  data-tab-id={tab.id}
                  title={getTabTitle(tab)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-left"
                  onClick={() => onSetActiveTab(tab.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startEditing(tab)
                  }}
                >
                  <StatusDot status={tab.status} />
                  {tab.type === 'sftp' && <Folder className="h-3.5 w-3.5 flex-shrink-0 text-brand-400" />}
                  {broadcastEnabled && tab.type === 'terminal' && tab.status === 'connected' && (
                    <Radio className="flex-shrink-0 w-3 h-3 text-amber-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{getTabDisplayName(tab)}</span>
                </button>
              )}

              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                className="mr-2 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 group-hover:opacity-100 max-[600px]:opacity-100"
                title={`Close ${getTabDisplayName(tab)}`}
              >
                <X className="w-3 h-3" />
              </button>
            </m.div>
          ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Spacer + Broadcast toggle + Close All + Settings + Logout */}
      <div className={clsx('h-10 flex-shrink-0 flex items-center', compactSidebar && 'col-start-3 row-start-2 justify-self-end')}>
      {inSplitMode && !compactSidebar && (
        <button
          onClick={onExitSplit}
          title="Exit split mode"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs text-brand-400 bg-brand-500/10 hover:bg-brand-500/20 transition-colors border-l border-surface-800 max-[900px]:w-10 max-[900px]:px-0"
        >
          <X className="w-3.5 h-3.5" />
          <span className="max-[900px]:hidden">Exit split</span>
        </button>
      )}
      {tabs.length >= 2 && (!compactSidebar || !inSplitMode) && (
        <button
          onClick={onOpenSplitPicker}
          title="Split layout"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-l border-surface-800 max-[900px]:w-10 max-[900px]:px-0"
        >
          <Columns2 className="w-3.5 h-3.5" />
          <span className="max-[900px]:hidden">Split</span>
        </button>
      )}
      {connectedCount >= 2 && !compactSidebar && (
        <button
          onClick={onOpenBroadcastPicker}
          title={broadcastEnabled ? 'Broadcast active — click to manage' : 'Broadcast input to multiple terminals'}
          className={clsx(
            'h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs border-l border-surface-800 transition-colors max-[900px]:w-10 max-[900px]:px-0',
            broadcastEnabled
              ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20'
              : 'text-slate-500 hover:text-slate-300 hover:bg-surface-800'
          )}
        >
          <Radio className="w-3.5 h-3.5" />
          <span className="max-[900px]:hidden">Broadcast</span>
        </button>
      )}
      {tabs.length > 0 && !compactSidebar && (
        <button
          onClick={onCloseAllTabs}
          title="Close all tabs"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1 px-3 text-xs text-slate-500 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800 max-[900px]:w-10 max-[900px]:px-0"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
          <span className="max-[900px]:hidden">Close All</span>
        </button>
      )}
      {!compactSidebar && <button
        onClick={onOpenSettings}
        title={`Settings (${modKey}+,)`}
        className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-surface-800 transition-colors border-l border-surface-800"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>}
      {ldapEnabled && isAdmin && (
        <button
          onClick={() => onOpenAdmin?.()}
          title="Admin console"
          className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-500 hover:text-brand-300 hover:bg-surface-800 transition-colors border-l border-surface-800"
        >
          <Shield className="w-3.5 h-3.5" />
        </button>
      )}
      {ldapEnabled && (
        <button
          onClick={submitLogout}
          title="Logout"
          className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-red-500 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      )}
      </div>

      {/* Context menu */}
      <AnimatePresence>
      {contextMenu && (() => {
        const tab = tabs.find(t => t.id === contextMenu.tabId)
        if (!tab) return null
        return (
          <m.div
            {...anchoredSurface}
            transition={{ ...exitTransition }}
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
            {tab.type === 'terminal' && tab.status === 'connected' && (
              <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); onOpenSftpTab(tab.id) }}
              >
                <Folder className="w-3 h-3" />
                Open SFTP
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); onCloneTab(tab.id) }}
              >
                <GitFork className="w-3 h-3" />
                Clone (same connection)
              </button>
              </>
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
          </m.div>
        )
      })()}
      </AnimatePresence>

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
