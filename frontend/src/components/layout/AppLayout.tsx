import { Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getSocket } from '@/hooks/useSocket'
import { useTerminalStore } from '@/store/terminalStore'
import { useLayoutStore, getLayoutTabIds } from '@/store/layoutStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useSFTPStore } from '@/store/sftpStore'
import TabBar, { type TabBarActions } from './TabBar'
import SplitPane from './SplitPane'
import LayoutPickerModal from './LayoutPickerModal'
import BroadcastPickerModal from './BroadcastPickerModal'
import SessionSidebar from './SessionSidebar'
const TerminalPane = lazy(() => import('@/components/terminal/TerminalPane'))
const SFTPBrowser = lazy(() => import('@/components/sftp/SFTPBrowser'))
import SettingsDialog from '@/components/settings/SettingsDialog'
import Logo from '@/components/ui/Logo'
import AuthRedirectOverlay from '@/components/ui/AuthRedirectOverlay'
import CommandPalette from '@/components/ui/CommandPalette'
import PendingCloseDialog from './PendingCloseDialog'
import { AUTH_LOGOUT_EVENT, AUTH_REDIRECT_EVENT, redirectToLdapLogin } from '@/utils/authRedirect'
import { tabDisplayName } from '@/lib/tabName'
import { PaneErrorBoundary, PaneErrorFallback } from '@/components/ui/PaneErrorBoundary'
import { BREAKPOINTS, below } from '@/lib/breakpoints'
import type { PaneNode } from '@/store/layoutStore'
import type { SavedServer, Tab } from '@/types'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, fade, surfaceTransition } from '@/motion/tokens'

const SESSION_RESTORE_RETRY_MS = 3_000

type PendingClose = {
  kind: 'tab' | 'pane'
  tabId: string
} | {
  kind: 'all'
} | null

type AuthErrorPayload = {
  code?: string
}

const SFTP_AUTH_RESULT_EVENTS = [
  'sftp:error',
  'sftp:open:result',
  'sftp:list:result',
  'sftp:delete:result',
  'sftp:rename:result',
  'sftp:mkdir:result',
  'sftp:chmod:result',
  'sftp:chown:result',
  'sftp:download:result',
  'sftp:accounts:result',
] as const

function getCloseTitle(tab: Tab | undefined): string {
  return tab?.type === 'sftp' ? 'Close SFTP tab?' : 'Close session?'
}

function getCloseMessage(tab: Tab | undefined, tabs: Tab[]): string {
  const name = tab ? tabDisplayName(tab, tabs) : 'this tab'
  if (tab?.type === 'sftp') return `Closing ${name} will close its SFTP browser.`
  return `Closing ${name} will disconnect its SSH session.`
}

type AppLayoutProps = {
  navigateToAdmin?: () => void
}

export default function AppLayout({ navigateToAdmin = () => window.location.assign('/admin') }: AppLayoutProps = {}) {
  const tabs = useTerminalStore(s => s.tabs)
  const activeTabId = useTerminalStore(s => s.activeTabId)
  const sessionId = useTerminalStore(s => s.sessionId)
  const addTab = useTerminalStore(s => s.addTab)
  const addSftpTab = useTerminalStore(s => s.addSftpTab)
  const closeTab = useTerminalStore(s => s.closeTab)
  const closeAllTabs = useTerminalStore(s => s.closeAllTabs)
  const setActiveTab = useTerminalStore(s => s.setActiveTab)
  const layoutRoot = useLayoutStore(s => s.root)
  const closePane = useLayoutStore(s => s.closePane)
  const exitSplitMode = useLayoutStore(s => s.exitSplitMode)
  const applyLayout = useLayoutStore(s => s.applyLayout)
  const broadcastEnabled = useBroadcastStore(s => s.enabled)
  const excludedTabIds = useBroadcastStore(s => s.excludedTabIds)
  const disableBroadcast = useBroadcastStore(s => s.disable)
  const setSFTPDisconnected = useSFTPStore(s => s.setDisconnected)
  const socket = getSocket()

  const [isCompactViewport, setIsCompactViewport] = useState(() => window.matchMedia(below(BREAKPOINTS.md2)).matches)
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(below(BREAKPOINTS.md2)).matches)

  useEffect(() => {
    const compactViewport = window.matchMedia(below(BREAKPOINTS.md2))
    const handleCompactViewport = (event: MediaQueryListEvent) => {
      setIsCompactViewport(event.matches)
      if (event.matches) setSidebarOpen(false)
    }
    compactViewport.addEventListener('change', handleCompactViewport)
    return () => compactViewport.removeEventListener('change', handleCompactViewport)
  }, [])

  useEffect(() => {
    if (!isCompactViewport || !sidebarOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isCompactViewport, sidebarOpen])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [splitPickerOpen, setSplitPickerOpen] = useState(false)
  const [broadcastPickerOpen, setBroadcastPickerOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  // true when split was initiated by broadcast — exiting broadcast exits split
  // too. Lives in broadcastStore (not local state) so terminalStore's
  // setActiveTab can read/clear it for every caller, not just this component.
  const splitOwnedByBroadcast = useBroadcastStore(s => s.splitOwned)
  const setSplitOwnedByBroadcast = useBroadcastStore(s => s.setSplitOwned)
  const [pendingClose, setPendingClose] = useState<PendingClose>(null)
  const pendingCloseCancelRef = useRef<HTMLButtonElement>(null)
  const dismissPendingClose = useCallback(() => setPendingClose(null), [])
  const skipBeforeUnloadRef = useRef(false)

  const shouldWarnBeforeClosingTab = useCallback((tabId: string) => {
    const tab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (!tab) return false
    if (tab.type === 'sftp') return true
    return tab.status === 'connected'
  }, [])

  const closeRemoteTab = useCallback((tabId: string) => {
    const tab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (tab?.type === 'sftp') {
      socket.emit('sftp:close', { session_id: sessionId, tab_id: tabId })
      return
    }
    socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tabId })
  }, [socket, sessionId])

  // Warn before close/reload if any active SSH sessions
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (skipBeforeUnloadRef.current) return
      const hasActive = useTerminalStore.getState().tabs.some(t => t.type === 'terminal' && t.status === 'connected')
      if (!hasActive) return
      e.preventDefault()
      e.returnValue = 'You have active SSH sessions. Leave anyway?'
      return e.returnValue
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    const onAuthNavigation = () => {
      skipBeforeUnloadRef.current = true
    }
    // Logging out navigates on purpose too: a native "leave?" prompt there would
    // strand the user under the non-dismissable "Signing out" overlay on Cancel.
    window.addEventListener(AUTH_REDIRECT_EVENT, onAuthNavigation)
    window.addEventListener(AUTH_LOGOUT_EVENT, onAuthNavigation)
    return () => {
      window.removeEventListener(AUTH_REDIRECT_EVENT, onAuthNavigation)
      window.removeEventListener(AUTH_LOGOUT_EVENT, onAuthNavigation)
    }
  }, [])

  // Socket.IO bypasses FastAPI middleware, so expired LDAP sessions are reported
  // by socket events. Send the browser through LDAPGate instead of showing the SSH form.
  useEffect(() => {
    const onError = (payload: AuthErrorPayload | undefined) => {
      if (payload?.code !== 'auth_required') return
      redirectToLdapLogin()
    }
    socket.on('ssh:error', onError)
    for (const eventName of SFTP_AUTH_RESULT_EVENTS) {
      socket.on(eventName, onError)
    }
    return () => {
      socket.off('ssh:error', onError)
      for (const eventName of SFTP_AUTH_RESULT_EVENTS) {
        socket.off(eventName, onError)
      }
    }
  }, [socket])

  // Keep inactive SFTP tabs in sync when their source SSH tab closes.
  useEffect(() => {
    const markSourceDead = (sourceTabId: string) => {
      const currentTabs = useTerminalStore.getState().tabs
      for (const tab of currentTabs) {
        if (tab.type === 'sftp' && tab.sourceTabId === sourceTabId) {
          const sftpState = useSFTPStore.getState().tabs[tab.id]
          if (!sftpState?.disconnected) setSFTPDisconnected(tab.id, true)
          if (tab.status !== 'dead') useTerminalStore.getState().setTabStatus(tab.id, 'dead')
        }
      }
    }
    const onSourceClosed = (payload: { tab_id?: string }) => {
      if (payload.tab_id) markSourceDead(payload.tab_id)
    }
    const onSourceRestored = (payload: { tab_id?: string; status?: string }) => {
      if (payload.tab_id && payload.status !== undefined && payload.status !== 'active') {
        markSourceDead(payload.tab_id)
      }
    }
    socket.on('ssh:closed', onSourceClosed)
    socket.on('ssh:error', onSourceClosed)
    socket.on('session:restored', onSourceRestored)
    return () => {
      socket.off('ssh:closed', onSourceClosed)
      socket.off('ssh:error', onSourceClosed)
      socket.off('session:restored', onSourceRestored)
    }
  }, [setSFTPDisconnected, socket])

  useEffect(() => {
    const currentTabIds = new Set(tabs.map(tab => tab.id))
    for (const tab of tabs) {
      if (tab.type === 'sftp' && tab.sourceTabId && !currentTabIds.has(tab.sourceTabId)) {
        const sftpState = useSFTPStore.getState().tabs[tab.id]
        if (!sftpState?.disconnected) setSFTPDisconnected(tab.id, true)
        if (tab.status !== 'dead') useTerminalStore.getState().setTabStatus(tab.id, 'dead')
      }
    }
  }, [setSFTPDisconnected, tabs])

  // Re-register all terminals after Socket.IO reconnects. A lost restore event
  // must not leave a terminal's input suppressed indefinitely.
  useEffect(() => {
    const restoreRetries = new Map<string, number>()
    const clearRestoreRetry = (tabId: string) => {
      const retry = restoreRetries.get(tabId)
      if (retry === undefined) return
      window.clearTimeout(retry)
      restoreRetries.delete(tabId)
    }
    const register = (tabId: string, sid: string) => {
      socket.emit('session:register', { session_id: sid, tab_id: tabId })
      clearRestoreRetry(tabId)
      restoreRetries.set(tabId, window.setTimeout(() => {
        restoreRetries.delete(tabId)
        if (socket.connected) socket.emit('session:register', { session_id: sid, tab_id: tabId })
      }, SESSION_RESTORE_RETRY_MS))
    }
    const onConnect = () => {
      const { tabs: currentTabs, sessionId: sid } = useTerminalStore.getState()
      for (const tab of currentTabs) {
        if (tab.type === 'terminal') register(tab.id, sid)
      }
    }
    const onRestored = (payload: { tab_id?: string }) => {
      if (payload.tab_id) clearRestoreRetry(payload.tab_id)
    }
    const onDisconnect = () => {
      for (const tabId of restoreRetries.keys()) clearRestoreRetry(tabId)
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('session:restored', onRestored)
    if (socket.connected) onConnect()
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('session:restored', onRestored)
      onDisconnect()
    }
  }, [socket])

  const handleAddTab = useCallback(() => {
    const tabId = addTab()
    socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
  }, [addTab, socket, sessionId])

  // Closing the active tab's pane must keep a layout tab active, otherwise the
  // shell falls back to the single view of a tab that is no longer in the split.
  const keepLayoutTabActive = useCallback((closingTabId: string) => {
    if (useTerminalStore.getState().activeTabId !== closingTabId) return
    const { focusedTabId } = useLayoutStore.getState()
    if (focusedTabId) setActiveTab(focusedTabId)
  }, [setActiveTab])

  const closePaneNow = useCallback((tabId: string) => {
    closeRemoteTab(tabId)
    const { root } = useLayoutStore.getState()
    if (!root) return
    const remaining = getLayoutTabIds(root).filter(id => id !== tabId)
    if (remaining.length <= 1) {
      exitSplitMode()
      if (remaining[0]) setActiveTab(remaining[0])
    } else {
      closePane(tabId)
      keepLayoutTabActive(tabId)
    }
  }, [closeRemoteTab, closePane, exitSplitMode, setActiveTab, keepLayoutTabActive])

  const closeTabNow = useCallback((id: string) => {
    const { root } = useLayoutStore.getState()
    if (root && getLayoutTabIds(root).includes(id)) {
      closeRemoteTab(id)
      const remaining = getLayoutTabIds(root).filter(tabId => tabId !== id)
      if (remaining.length <= 1) {
        exitSplitMode()
        if (remaining[0]) setActiveTab(remaining[0])
      } else {
        closePane(id)
        keepLayoutTabActive(id)
      }
    } else {
      closeRemoteTab(id)
    }
    closeTab(id)
  }, [closeRemoteTab, closeTab, closePane, exitSplitMode, setActiveTab, keepLayoutTabActive])

  const closeAllTabsNow = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    for (const tab of currentTabs.filter(t => t.type === 'terminal')) {
      socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tab.id })
    }
    for (const tab of currentTabs.filter(t => t.type === 'sftp')) {
      socket.emit('sftp:close', { session_id: sessionId, tab_id: tab.id })
    }
    exitSplitMode()
    disableBroadcast()
    closeAllTabs()
  }, [socket, sessionId, closeAllTabs, exitSplitMode, disableBroadcast])

  const handleClosePane = useCallback((tabId: string) => {
    if (shouldWarnBeforeClosingTab(tabId)) {
      setPendingClose({ kind: 'pane', tabId })
      return
    }
    closePaneNow(tabId)
  }, [shouldWarnBeforeClosingTab, closePaneNow])

  const handleCloseTab = useCallback((id: string) => {
    if (shouldWarnBeforeClosingTab(id)) {
      setPendingClose({ kind: 'tab', tabId: id })
      return
    }
    closeTabNow(id)
  }, [shouldWarnBeforeClosingTab, closeTabNow])

  const handleCloneTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || sourceTab.status !== 'connected' || !sourceTab.host || !sourceTab.username) return
    const newTabId = addTab()
    socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host, sourceTab.port ?? 22, sourceTab.username)
    const baseName = sourceTab.label ?? `${sourceTab.username}@${sourceTab.host}`
    store.renameTab(newTabId, `${baseName} (clone)`)
    store.setTabStatus(newTabId, 'connecting')
    socket.emit('ssh:clone', {
      session_id: sessionId, source_tab_id: sourceTabId, new_tab_id: newTabId, cols: 220, rows: 50,
    })
  }, [addTab, socket, sessionId])

  const handleOpenSftpTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || sourceTab.status !== 'connected') return
    const tabId = addSftpTab(sourceTabId)
    socket.emit('session:register', { session_id: sessionId, tab_id: sourceTabId })
    setActiveTab(tabId)
  }, [addSftpTab, socket, sessionId, setActiveTab])

  // terminalStore's setActiveTab already exits a broadcast-owned split when
  // the target tab isn't in the current layout (every caller gets this, not
  // just this component), so this is a plain alias kept for call-site clarity.
  const handleSetActiveTab = setActiveTab

  const handleCloseAllTabs = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    const terminalTabs = currentTabs.filter(t => t.type === 'terminal')
    const sftpTabs = currentTabs.filter(t => t.type === 'sftp')
    const hasActive = terminalTabs.some(t => t.status === 'connected') || sftpTabs.length > 0
    if (hasActive) {
      setPendingClose({ kind: 'all' })
      return
    }
    closeAllTabsNow()
  }, [closeAllTabsNow])

  const handleDuplicateTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || !sourceTab.host || !sourceTab.username) return
    const newTabId = addTab()
    socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host, sourceTab.port ?? 22, sourceTab.username)
    if (sourceTab.label) store.renameTab(newTabId, sourceTab.label)
  }, [addTab, socket, sessionId])

  const handleLoadSession = useCallback((server: SavedServer) => {
    const tabId = addTab()
    socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(tabId, server.host, server.port, server.username)
    store.renameTab(tabId, server.name)
  }, [addTab, socket, sessionId])

  // Apply a layout from the Split picker (manual split, broadcast does not own it)
  const handleApplyLayout = useCallback((root: PaneNode) => {
    // Every tab here is already registered on this socket (at creation and on
    // reconnect). Registering again replays its output buffer into an xterm
    // that already holds it, duplicating the scrollback.
    const tabIds = getLayoutTabIds(root)
    applyLayout(root)
    if (!activeTabId || !tabIds.includes(activeTabId)) setActiveTab(tabIds[0])
    setSplitOwnedByBroadcast(false)
    setSplitPickerOpen(false)
  }, [applyLayout, setActiveTab, activeTabId])

  // Broadcast: apply selected terminals + auto-layout
  const handleApplyBroadcast = useCallback((includedTabIds: string[], layout: PaneNode | null) => {
    // Set excludedTabIds = all connected tabs NOT in includedTabIds
    const allConnected = useTerminalStore.getState().tabs.filter(t => t.status === 'connected')
    const excluded = allConnected.filter(t => !includedTabIds.includes(t.id)).map(t => t.id)

    // Update broadcast store directly
    useBroadcastStore.setState({ enabled: true, excludedTabIds: excluded })

    if (layout) {
      const tabIds = getLayoutTabIds(layout)
      // Only take ownership of split if no split was already active
      const hadSplit = useLayoutStore.getState().root !== null
      applyLayout(layout)
      if (!activeTabId || !tabIds.includes(activeTabId)) setActiveTab(tabIds[0])
      if (!hadSplit) setSplitOwnedByBroadcast(true)
    }
    setBroadcastPickerOpen(false)
  }, [applyLayout, setActiveTab, activeTabId])

  const handleDisableBroadcast = useCallback(() => {
    disableBroadcast()
    if (splitOwnedByBroadcast) {
      exitSplitMode()
      setSplitOwnedByBroadcast(false)
    }
    setBroadcastPickerOpen(false)
  }, [disableBroadcast, exitSplitMode, splitOwnedByBroadcast])

  // Keep application shortcuts separate from browser-owned tab and omnibox keys.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const connectedTabs = useMemo(() => tabs.filter(t => t.type === 'terminal' && t.status === 'connected'), [tabs])
  const broadcastIncluded = useMemo(
    () => new Set(connectedTabs.filter(t => !excludedTabIds.includes(t.id)).map(t => t.id)),
    [connectedTabs, excludedTabIds]
  )
  const activeTabInLayout = useMemo(
    () => layoutRoot ? getLayoutTabIds(layoutRoot).includes(activeTabId || '') : false,
    [layoutRoot, activeTabId]
  )
  const pendingCloseTab = useMemo(
    () => pendingClose && pendingClose.kind !== 'all' ? tabs.find(t => t.id === pendingClose.tabId) : undefined,
    [pendingClose, tabs]
  )

  const tabBarActions = useMemo<TabBarActions>(() => ({
    addTab: handleAddTab,
    closeTab: handleCloseTab,
    cloneTab: handleCloneTab,
    openSftpTab: handleOpenSftpTab,
    duplicateTab: handleDuplicateTab,
    closeAllTabs: handleCloseAllTabs,
    openSettings: () => setSettingsOpen(true),
    openAdmin: () => {
      skipBeforeUnloadRef.current = true
      navigateToAdmin()
    },
    openSplitPicker: () => setSplitPickerOpen(true),
    openBroadcastPicker: () => setBroadcastPickerOpen(true),
    exitSplit: () => { exitSplitMode(); setSplitOwnedByBroadcast(false) },
    toggleSidebar: () => setSidebarOpen(o => !o),
    openCommandPalette: () => setCommandPaletteOpen(true),
    setActiveTab: handleSetActiveTab,
  }), [handleAddTab, handleCloseTab, handleCloneTab, handleOpenSftpTab, handleDuplicateTab, handleCloseAllTabs, exitSplitMode, navigateToAdmin, handleSetActiveTab])

  const handleConfirmPendingClose = useCallback(() => {
    if (!pendingClose) return
    setPendingClose(null)
    if (pendingClose.kind === 'all') {
      closeAllTabsNow()
      return
    }
    const { kind, tabId } = pendingClose
    if (kind === 'pane') {
      closePaneNow(tabId)
    } else {
      closeTabNow(tabId)
    }
  }, [pendingClose, closePaneNow, closeTabNow, closeAllTabsNow])

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={surfaceTransition}
      className="flex h-full bg-surface-950"
    >
      <AuthRedirectOverlay />
      <h1 className="sr-only">Torrus — web SSH terminal</h1>
      <a
        href="#torrus-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-overlay focus:rounded focus:bg-surface-800 focus:px-3 focus:py-2 focus:text-sm focus:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Skip to terminal
      </a>
      <AnimatePresence initial={false}>
        {(!isCompactViewport || sidebarOpen) && (
          <SessionSidebar
            key={isCompactViewport ? 'compact-sidebar' : 'desktop-sidebar'}
            isOpen={sidebarOpen}
            compact={isCompactViewport}
            onToggle={() => setSidebarOpen(o => !o)}
            onLoadSession={(server) => {
              handleLoadSession(server)
              if (isCompactViewport) setSidebarOpen(false)
            }}
          />
        )}
      </AnimatePresence>

      <div className="flex flex-col flex-1 min-w-0">
        <TabBar
          compactSidebar={isCompactViewport}
          sidebarOpen={sidebarOpen}
          inSplitMode={!!layoutRoot}
          actions={tabBarActions}
        />

        <main id="torrus-main" tabIndex={-1} className="flex-1 relative overflow-hidden min-h-0 focus:outline-none">
          {/* The empty state and the single/split shells cross-fade; `initial={false}`
              keeps the first paint still, and the key stays constant for plain tab
              switches so their own keyframe animation is not remounted. `mode="wait"`
              matters: a terminal pane adopts its cached xterm node on mount and its
              cleanup detaches that node, so the outgoing branch has to be gone before
              the incoming one mounts. */}
          <AnimatePresence initial={false} mode="wait">
          {tabs.length === 0 ? (
            <m.div key="empty-state" {...fade} transition={exitTransition} className="flex h-full flex-col items-center justify-center gap-4 text-slate-400">
              <Logo size="lg" showText={false} className="opacity-40" />
              <p className="max-w-sm px-6 text-center text-sm leading-relaxed text-balance">Open a terminal tab or select a saved session from the sidebar</p>
            </m.div>
          ) : layoutRoot && activeTabInLayout ? (
            <m.div key="split-layout" {...fade} transition={exitTransition} className="absolute inset-0">
              <SplitPane
                node={layoutRoot}
                socket={socket}
                onClose={handleClosePane}
                isOnlyPane={layoutRoot.type === 'leaf'}
              />
            </m.div>
          ) : (
            <m.div key="single-layout" {...fade} transition={exitTransition}>
            {tabs.map(tab => (
              <div
                key={tab.id}
                id={`torrus-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`torrus-tab-${tab.id}`}
                className={`absolute inset-0 motion-safe:animate-[torrus-tab-content-in_var(--motion-duration-surface)_var(--motion-ease-move)]`}
                style={{ display: tab.id === activeTabId ? 'flex' : 'none', flexDirection: 'column' }}
              >
                <PaneErrorBoundary fallback={<PaneErrorFallback message="This pane failed to load" />}>
                  <Suspense fallback={<PaneFallback />}>
                    {tab.type === 'sftp' ? (
                      <SFTPBrowser tabId={tab.id} sourceTabId={tab.sourceTabId} socket={socket} />
                    ) : (
                      <TerminalPane tabId={tab.id} isActive={tab.id === activeTabId} socket={socket} />
                    )}
                  </Suspense>
                </PaneErrorBoundary>
              </div>
            ))}
            </m.div>
          )}
          </AnimatePresence>
        </main>
      </div>

      <AnimatePresence>
      {commandPaletteOpen && (
        <CommandPalette
          tabs={tabs}
          activeTabId={activeTabId}
          canSplit={tabs.length >= 2}
          canBroadcast={connectedTabs.length >= 2}
          inSplitMode={!!layoutRoot}
          onAddTab={handleAddTab}
          onSelectTab={handleSetActiveTab}
          onOpenSftpTab={handleOpenSftpTab}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSplitPicker={() => setSplitPickerOpen(true)}
          onOpenBroadcastPicker={() => setBroadcastPickerOpen(true)}
          onExitSplit={() => { exitSplitMode(); setSplitOwnedByBroadcast(false) }}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
      </AnimatePresence>

      <AnimatePresence>
      {settingsOpen && <SettingsDialog key="settings" onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
      {splitPickerOpen && (
        <LayoutPickerModal
          tabs={tabs}
          onApply={handleApplyLayout}
          onClose={() => setSplitPickerOpen(false)}
        />
      )}
      </AnimatePresence>

      <AnimatePresence>
      {broadcastPickerOpen && (
        <BroadcastPickerModal
          connectedTabs={connectedTabs}
          initialIncluded={broadcastIncluded}
          broadcastEnabled={broadcastEnabled}
          onApply={handleApplyBroadcast}
          onDisable={handleDisableBroadcast}
          onClose={() => setBroadcastPickerOpen(false)}
        />
      )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
      {pendingClose && (
        <PendingCloseDialog
          key="pending-close"
          kind={pendingClose.kind}
          title={pendingClose.kind === 'all' ? 'Close all tabs?' : getCloseTitle(pendingCloseTab)}
          message={pendingClose.kind === 'all'
            ? 'Closing all tabs will disconnect SSH sessions and close SFTP browsers.'
            : getCloseMessage(pendingCloseTab, tabs)}
          cancelRef={pendingCloseCancelRef}
          onCancel={dismissPendingClose}
          onConfirm={handleConfirmPendingClose}
        />
      )}
      </AnimatePresence>
    </m.div>
  )
}

/** Shown while a lazily loaded pane's chunk arrives. */
function PaneFallback() {
  return <div className="flex h-full items-center justify-center text-xs text-slate-400">Loading…</div>
}
