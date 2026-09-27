import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type FormEvent } from 'react'
import { Plus, X, Pencil, Bookmark, Copy, Folder, GitFork, Settings, LogOut, Menu, PanelLeftClose, Radio, Columns2, Command, Shield, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import Dialog from '@/components/ui/Dialog'
import { useTerminalStore } from '@/store/terminalStore'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import Logo from '@/components/ui/Logo'
import type { Tab } from '@/types'
import { modKey } from '@/utils/platform'
import { submitLdapLogout } from '@/utils/authRedirect'
import { handleMenuKeyDown } from '@/lib/menuKeys'
import { useDismissLayer } from '@/lib/dismissLayers'
import { tabDisplayName } from '@/lib/tabName'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { anchoredSurface, exitTransition, fade, surfaceSpring, surfaceTransition } from '@/motion/tokens'

/**
 * Everything the bar can ask the shell to do. They stay owned by AppLayout
 * because most of them emit socket events or open dialogs; grouping them keeps
 * this interface small and adds no orchestration here.
 */
export interface TabBarActions {
  addTab: () => void
  closeTab: (id: string) => void
  cloneTab: (id: string) => void
  openSftpTab: (id: string) => void
  duplicateTab: (id: string) => void
  closeAllTabs: () => void
  openSettings: () => void
  openAdmin: () => void
  openSplitPicker: () => void
  openBroadcastPicker: () => void
  exitSplit: () => void
  toggleSidebar: () => void
  openCommandPalette: () => void
  setActiveTab: (id: string) => void
}

interface TabBarProps {
  actions: TabBarActions
  inSplitMode: boolean
  compactSidebar?: boolean
  sidebarOpen?: boolean
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
      className={cn('size-1.5 rounded-full flex-shrink-0', {
        'bg-slate-500': status === 'disconnected',
        'bg-brand-400 animate-pulse': status === 'connecting',
        'bg-green-400': status === 'connected',
        'bg-red-400': status === 'dead',
      })}
    />
  )
}

function getTabTitle(tab: Tab, displayName: string): string {
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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const ok = onSave(name.trim() || `${state.tab.username}@${state.tab.host}`)
    if (!ok) setError('This session already exists.')
  }

  return (
    <Dialog label="Save Session" initialFocus={inputRef} onClose={onClose} className="w-72 gap-3">
        <div className="flex items-center gap-2">
          <Bookmark className="size-4 text-brand-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-200">Save Session</h2>
        </div>
        <p className="text-xs text-slate-400">
          {state.tab.username}@{state.tab.host}{state.tab.port !== 22 ? `:${state.tab.port}` : ''}
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="save-session-name" className="text-xs text-slate-400 font-medium">Name</label>
            <input
              id="save-session-name"
              name="session-name"
              autoComplete="off"
              ref={inputRef}
              className="w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus:border-brand-500 transition-colors"
              placeholder={`${state.tab.username}@${state.tab.host}…`}
              value={name}
              onChange={e => setName(e.target.value)}
              spellCheck={false}
            />
          </div>
          <AnimatePresence initial={false}>
            {error && <m.p role="alert" {...fade} transition={exitTransition} className="text-xs text-red-400 text-center">{error}</m.p>}
          </AnimatePresence>
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
              className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-brand-700 hover:bg-brand-600 transition-colors"
            >
              Save
            </button>
          </div>
        </form>
    </Dialog>
  )
}

export default function TabBar({ actions, inSplitMode, compactSidebar = false, sidebarOpen = false }: TabBarProps) {
  const tabs = useTerminalStore(s => s.tabs)
  const activeTabId = useTerminalStore(s => s.activeTabId)
  const renameTab = useTerminalStore(s => s.renameTab)
  const moveTab = useTerminalStore(s => s.moveTab)
  // Activated through the shell's handler, not the raw store setter: leaving a
  // broadcast-owned split is that handler's job.
  const onSetActiveTab = actions.setActiveTab
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const addServer = useSavedServerStore(s => s.addServer)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const isAdmin = useServerConfigStore(s => s.isAdmin)
  const broadcastEnabled = useBroadcastStore(s => s.enabled)
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

  // A dialog whose tab has been closed is simply not the dialog to render; the
  // state is replaced when the next tab opens one, so no effect has to clear it.
  const activeSaveDialog = saveDialog && tabs.some(t => t.id === saveDialog.tab.id) ? saveDialog : null

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
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  // Escape never reaches the menu's own keydown handler: the dismiss layer runs
  // on window capture and stops propagation, so focus is restored here.
  useDismissLayer(!!contextMenu, () => {
    const tabId = contextMenu?.tabId
    setContextMenu(null)
    if (tabId) tabRefs.current[tabId]?.focus()
  })

  // Take focus so Escape and the arrow keys reach the menu instead of xterm.
  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [contextMenu])

  const startEditing = useCallback((tab: Tab) => {
    setEditingTabId(tab.id)
    setEditValue(tabDisplayName(tab, tabs))
    setContextMenu(null)
  }, [tabs])

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
    <div className={cn('flex-shrink-0 bg-surface-900 border-b border-surface-800', compactSidebar ? 'grid h-[92px] grid-cols-[40px_minmax(0,1fr)_40px] grid-rows-[46px_46px]' : 'h-[46px] flex items-center')}>
      {compactSidebar && (
        <button
          type="button"
          onClick={actions.toggleSidebar}
          title={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          aria-label={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          aria-expanded={sidebarOpen}
          className="col-start-1 row-start-1 h-[46px] w-10 flex-shrink-0 flex items-center justify-center text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200"
        >
          <Menu className="size-4" />
        </button>
      )}
      {/* Logo branding */}
      <div className={cn('h-10 flex-shrink-0 flex items-center px-3 border-r border-surface-800', compactSidebar ? 'col-start-2 row-start-1 self-center border-r-0 px-2 [&>div>span]:inline' : 'max-nav:w-10 max-nav:justify-center max-nav:px-2 max-nav:[&>div>span]:hidden')}>
        <Logo size="sm" showText={true} />
      </div>

      {compactSidebar && (
        <button type="button" onClick={actions.openCommandPalette} title="Open command palette" aria-label="Open command palette" className="col-start-3 row-start-1 flex h-[46px] w-10 justify-self-end items-center justify-center text-slate-400 transition-colors hover:bg-surface-800 hover:text-slate-200">
          <Command className="size-4" />
        </button>
      )}

      {/* New tab button */}
      <button
        type="button"
        onClick={actions.addTab}
        title="New tab"
        aria-label="New tab"
        className={cn('h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-400 hover:text-slate-300 hover:bg-surface-800 transition-colors border-r border-surface-800', compactSidebar && 'col-start-1 row-start-2 self-center')}
      >
        <Plus className="size-4" aria-hidden="true" />
      </button>

      {/* Tab buttons */}
      <div className={cn('flex-1 h-full min-w-0 overflow-hidden', compactSidebar && 'col-start-2 row-start-2', compactSidebar && inSplitMode && 'col-end-4')}>
        <div
          ref={tabListRef}
          className="torrus-tab-strip flex h-full items-center flex-nowrap overflow-x-scroll overflow-y-hidden"
          role="tablist"
          aria-label="Open tabs"
          onKeyDown={(event) => {
            // The rename field lives inside this tablist; its own arrow keys
            // move the caret, so the strip must not claim them while it's open.
            if (editingTabId && event.target === editInputRef.current) return
            // WCAG 2.5.7: reordering is also available without dragging.
            if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
              const focusedId = (document.activeElement as HTMLElement | null)?.dataset.tabId ?? null
              const movingId = focusedId ?? activeTabId
              if (!movingId) return
              const index = tabs.findIndex(tab => tab.id === movingId)
              const target = index + (event.key === 'ArrowRight' ? 1 : -1)
              if (index === -1 || target < 0 || target >= tabs.length) return
              event.preventDefault()
              moveTab(movingId, tabs[target].id)
              requestAnimationFrame(() => tabRefs.current[movingId]?.focus())
              return
            }
            if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
              if (!activeTabId) return
              const anchor = tabRefs.current[activeTabId]
              if (!anchor) return
              event.preventDefault()
              const rect = anchor.getBoundingClientRect()
              setContextMenu({ tabId: activeTabId, x: rect.left, y: rect.bottom })
              return
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            const index = tabs.findIndex(tab => tab.id === activeTabId)
            if (index === -1) return
            event.preventDefault()
            const step = event.key === 'ArrowRight' ? 1 : -1
            const next = tabs[(index + step + tabs.length) % tabs.length]
            onSetActiveTab(next.id)
            tabRefs.current[next.id]?.focus()
          }}
        >
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
              className={cn(
                'relative group h-10 flex flex-shrink-0 select-none items-center min-w-32 max-w-48 border-r border-surface-800 whitespace-nowrap transition-colors text-xs font-mono max-xs:min-w-28 max-xs:max-w-36',
                activeTabId === tab.id
                  ? 'bg-surface-950 text-slate-200'
                  : 'text-slate-400 hover:text-slate-300 hover:bg-surface-800'
              )}
            >
              <AnimatePresence initial={false}>
                {activeTabId === tab.id && (
                  <m.span initial={{ opacity: 0, scaleX: 0.65 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0 }} transition={surfaceTransition} className="pointer-events-none absolute inset-x-0 top-0 h-0.5 origin-center bg-brand-500" />
                )}
              </AnimatePresence>
              {editingTabId === tab.id ? (
                <input
                  ref={editInputRef}
                  className="ml-3 min-w-0 flex-1 bg-transparent border-b border-brand-500 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 text-xs font-mono text-slate-200"
                  aria-label={`Rename ${tabDisplayName(tab, tabs)}`}
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
                  id={`torrus-tab-${tab.id}`}
                  aria-controls={`torrus-panel-${tab.id}`}
                  aria-selected={activeTabId === tab.id}
                  tabIndex={activeTabId === tab.id ? 0 : -1}
                  data-tab-id={tab.id}
                  title={getTabTitle(tab, tabDisplayName(tab, tabs))}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-left"
                  onClick={() => onSetActiveTab(tab.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startEditing(tab)
                  }}
                >
                  <StatusDot status={tab.status} />
                  {tab.type === 'sftp' && <Folder className="size-3.5 flex-shrink-0 text-brand-400" aria-hidden="true" />}
                  {broadcastEnabled && tab.type === 'terminal' && tab.status === 'connected' && (
                    <Radio className="flex-shrink-0 size-3 text-amber-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{tabDisplayName(tab, tabs)}</span>
                </button>
              )}

              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); actions.closeTab(tab.id) }}
                className="mr-2 flex size-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 group-hover:opacity-100 max-xs:opacity-100"
                title={`Close ${tabDisplayName(tab, tabs)}`}
                aria-label={`Close ${tabDisplayName(tab, tabs)}`}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </m.div>
          ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Spacer + Broadcast toggle + Close All + Settings + Logout */}
      <div className={cn('h-10 flex-shrink-0 flex items-center', compactSidebar && 'col-start-3 row-start-2 justify-self-end')}>
      {inSplitMode && !compactSidebar && (
        <button
          onClick={actions.exitSplit}
          title="Exit split mode"
          aria-label="Exit split mode"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs text-brand-400 bg-brand-500/10 hover:bg-brand-500/20 transition-colors border-l border-surface-800 max-wide:w-10 max-wide:px-0"
        >
          <X className="size-3.5" aria-hidden="true" />
          <span className="max-wide:hidden">Exit split</span>
        </button>
      )}
      {tabs.length >= 2 && (!compactSidebar || !inSplitMode) && (
        <button
          onClick={actions.openSplitPicker}
          title="Split layout"
          aria-label="Split layout"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs text-slate-400 hover:text-slate-300 hover:bg-surface-800 transition-colors border-l border-surface-800 max-wide:w-10 max-wide:px-0"
        >
          <Columns2 className="size-3.5" aria-hidden="true" />
          <span className="max-wide:hidden">Split</span>
        </button>
      )}
      {connectedCount >= 2 && !compactSidebar && (
        <button
          onClick={actions.openBroadcastPicker}
          title={broadcastEnabled ? 'Broadcast active — click to manage' : 'Broadcast input to multiple terminals'}
          aria-label={broadcastEnabled ? 'Manage broadcast' : 'Broadcast input to multiple terminals'}
          className={cn(
            'h-10 flex-shrink-0 flex items-center justify-center gap-1.5 px-3 text-xs border-l border-surface-800 transition-colors max-wide:w-10 max-wide:px-0',
            broadcastEnabled
              ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20'
              : 'text-slate-400 hover:text-slate-300 hover:bg-surface-800'
          )}
        >
          <Radio className="size-3.5" aria-hidden="true" />
          <span className="max-wide:hidden">Broadcast</span>
        </button>
      )}
      {tabs.length > 0 && !compactSidebar && (
        <button
          onClick={actions.closeAllTabs}
          title="Close all tabs"
          aria-label="Close all tabs"
          className="h-10 flex-shrink-0 flex items-center justify-center gap-1 px-3 text-xs text-slate-400 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800 max-wide:w-10 max-wide:px-0"
        >
          <PanelLeftClose className="size-3.5" aria-hidden="true" />
          <span className="max-wide:hidden">Close All</span>
        </button>
      )}
      {!compactSidebar && <button
        onClick={actions.openSettings}
        title={`Settings (${modKey}+,)`}
        aria-label={`Settings (${modKey}+,)`}
        className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-400 hover:text-slate-300 hover:bg-surface-800 transition-colors border-l border-surface-800"
      >
        <Settings className="size-3.5" aria-hidden="true" />
      </button>}
      {ldapEnabled && isAdmin && (
        <button
          onClick={actions.openAdmin}
          title="Admin console"
          aria-label="Admin console"
          className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-slate-400 hover:text-brand-300 hover:bg-surface-800 transition-colors border-l border-surface-800"
        >
          <Shield className="size-3.5" aria-hidden="true" />
        </button>
      )}
      {ldapEnabled && (
        <button
          onClick={submitLogout}
          title="Logout"
          aria-label="Logout"
          className="h-10 flex-shrink-0 w-10 flex items-center justify-center text-red-500 hover:text-red-400 hover:bg-surface-800 transition-colors border-l border-surface-800"
        >
          <LogOut className="size-3.5" aria-hidden="true" />
        </button>
      )}
      </div>

      {/* Context menu */}
      <AnimatePresence>
      {contextMenu && (() => {
        const tab = tabs.find(t => t.id === contextMenu.tabId)
        if (!tab) return null
        const tabIndex = tabs.findIndex(candidate => candidate.id === tab.id)
        return (
          <m.div
            {...anchoredSurface}
            transition={{ ...exitTransition }}
            ref={contextMenuRef}
            role="menu"
            aria-label="Tab actions"
            onKeyDown={event => handleMenuKeyDown(event, contextMenuRef.current, () => {
              setContextMenu(null)
              tabRefs.current[contextMenu.tabId]?.focus()
            })}
            className="fixed z-menu bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-36"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type="button"
              role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
              onClick={() => startEditing(tab)}
            >
              <Pencil className="size-3" aria-hidden="true" />
              Rename
            </button>
            {tabIndex > 0 && (
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); moveTab(tab.id, tabs[tabIndex - 1].id) }}
              >
                <ChevronLeft className="size-3" />
                Move left
              </button>
            )}
            {tabIndex >= 0 && tabIndex < tabs.length - 1 && (
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); moveTab(tab.id, tabs[tabIndex + 1].id) }}
              >
                <ChevronRight className="size-3" />
                Move right
              </button>
            )}
            {tab.type === 'terminal' && tab.status === 'connected' && (
              <>
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); actions.openSftpTab(tab.id) }}
              >
                <Folder className="size-3" />
                Open SFTP
              </button>
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); actions.cloneTab(tab.id) }}
              >
                <GitFork className="size-3" />
                Clone (same connection)
              </button>
              </>
            )}
            {tab.host && tab.username && (
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => { setContextMenu(null); actions.duplicateTab(tab.id) }}
              >
                <Copy className="size-3" />
                Duplicate (new connection)
              </button>
            )}
            {tab.host && tab.username && (
              <button
                role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => {
                  setContextMenu(null)
                  setSaveDialog({
                    tab,
                    name: tab.label ?? `${tab.username}@${tab.host}`,
                  })
                }}
              >
                <Bookmark className="size-3" />
                Save to sessions
              </button>
            )}
            <div className="my-1 border-t border-surface-700" />
            <button
              type="button"
              role="menuitem" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors"
              onClick={() => { setContextMenu(null); actions.closeTab(tab.id) }}
            >
              <X className="size-3" />
              Close
            </button>
          </m.div>
        )
      })()}
      </AnimatePresence>

    </div>

    {/* Save session dialog — rendered outside the overflow-hidden TabBar */}
    <AnimatePresence initial={false}>
    {activeSaveDialog && (
      <SaveSessionDialog
        key="save-session"
        state={activeSaveDialog}
        onSave={(name) => {
          const ok = addServer({
            name,
            host: activeSaveDialog.tab.host!,
            port: activeSaveDialog.tab.port ?? 22,
            username: activeSaveDialog.tab.username!,
          })
          if (ok) setSaveDialog(null)
          return ok
        }}
        onClose={() => setSaveDialog(null)}
      />
    )}
    </AnimatePresence>
    </>
  )
}
