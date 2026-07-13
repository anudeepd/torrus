import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getSocket } from '@/hooks/useSocket'
import { useTerminalStore } from '@/store/terminalStore'
import { useLayoutStore, getLayoutTabIds } from '@/store/layoutStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import TabBar from './TabBar'
import SplitPane from './SplitPane'
import LayoutPickerModal from './LayoutPickerModal'
import BroadcastPickerModal from './BroadcastPickerModal'
import SessionSidebar from './SessionSidebar'
import TerminalPane from '@/components/terminal/TerminalPane'
import SFTPBrowser from '@/components/sftp/SFTPBrowser'
import SettingsDialog from '@/components/settings/SettingsDialog'
import Logo from '@/components/ui/Logo'
import AuthRedirectOverlay from '@/components/ui/AuthRedirectOverlay'
import { AUTH_REDIRECT_EVENT, redirectToLdapLogin } from '@/utils/authRedirect'
import type { PaneNode } from '@/store/layoutStore'
import type { SavedServer, Tab } from '@/types'

type PendingClose = {
  kind: 'tab' | 'pane'
  tabId: string
} | null

type SshErrorPayload = {
  code?: string
}

function getTabDisplayName(tab: Tab | undefined): string {
  if (!tab) return 'this tab'
  if (tab.label) return tab.label
  if (tab.host && tab.username) return `${tab.username}@${tab.host}`
  return 'New Connection'
}

export default function AppLayout() {
  const { tabs, activeTabId, addTab, addSftpTab, closeTab, closeAllTabs, setActiveTab, sessionId } = useTerminalStore()
  const { root: layoutRoot, closePane, exitSplitMode, applyLayout } = useLayoutStore()
  const { enabled: broadcastEnabled, excludedTabIds, disable: disableBroadcast } = useBroadcastStore()
  const socket = getSocket()

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [splitPickerOpen, setSplitPickerOpen] = useState(false)
  const [broadcastPickerOpen, setBroadcastPickerOpen] = useState(false)
  // true when split was initiated by broadcast — exiting broadcast exits split too
  const [splitOwnedByBroadcast, setSplitOwnedByBroadcast] = useState(false)
  const [pendingClose, setPendingClose] = useState<PendingClose>(null)
  const authRedirectingRef = useRef(false)

  const shouldWarnBeforeClosingTab = useCallback((tabId: string) => {
    const tab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (!tab) return false
    if (tab.type !== 'terminal') return false
    return tab.status !== 'disconnected' || !!tab.host || !!tab.username
  }, [])

  // Warn before close/reload if any active SSH sessions
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (authRedirectingRef.current) return
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
    const onAuthRedirect = () => {
      authRedirectingRef.current = true
    }
    window.addEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect)
    return () => window.removeEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect)
  }, [])

  // Socket.IO bypasses FastAPI middleware, so expired LDAP sessions are reported
  // by socket events. Send the browser through LDAPGate instead of showing the SSH form.
  useEffect(() => {
    const onError = (payload: SshErrorPayload | undefined) => {
      if (payload?.code !== 'auth_required') return
      redirectToLdapLogin()
    }
    socket.on('ssh:error', onError)
    return () => { socket.off('ssh:error', onError) }
  }, [socket])

  // Register all tabs on socket connect
  useEffect(() => {
    const onConnect = () => {
      const { tabs: currentTabs, sessionId: sid } = useTerminalStore.getState()
      for (const tab of currentTabs) {
        if (tab.type !== 'terminal') continue
        socket.emit('session:register', { session_id: sid, tab_id: tab.id })
      }
    }
    socket.on('connect', onConnect)
    if (socket.connected) onConnect()
    return () => { socket.off('connect', onConnect) }
  }, [socket])

  const handleAddTab = useCallback(() => {
    const tabId = addTab()
    socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
  }, [addTab, socket, sessionId])

  const closePaneNow = useCallback((tabId: string) => {
    socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tabId })
    const { root } = useLayoutStore.getState()
    if (!root) return
    const remaining = getLayoutTabIds(root).filter(id => id !== tabId)
    if (remaining.length <= 1) {
      exitSplitMode()
      if (remaining[0]) setActiveTab(remaining[0])
    } else {
      closePane(tabId)
    }
  }, [socket, sessionId, closePane, exitSplitMode, setActiveTab])

  const closeTabNow = useCallback((id: string) => {
    const { root } = useLayoutStore.getState()
    if (root && getLayoutTabIds(root).includes(id)) {
      socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: id })
      const remaining = getLayoutTabIds(root).filter(tabId => tabId !== id)
      if (remaining.length <= 1) {
        exitSplitMode()
        if (remaining[0]) setActiveTab(remaining[0])
      } else {
        closePane(id)
      }
    } else {
      socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: id })
    }
    closeTab(id)
  }, [socket, sessionId, closeTab, closePane, exitSplitMode, setActiveTab])

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

  const handleSetActiveTab = useCallback((tabId: string) => {
    if (layoutRoot) {
      const inLayout = getLayoutTabIds(layoutRoot).includes(tabId)
      if (!inLayout && splitOwnedByBroadcast) {
        exitSplitMode()
        disableBroadcast()
        setSplitOwnedByBroadcast(false)
      }
    }
    setActiveTab(tabId)
  }, [layoutRoot, exitSplitMode, splitOwnedByBroadcast, disableBroadcast, setActiveTab])

  const handleCloseAllTabs = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    const terminalTabs = currentTabs.filter(t => t.type === 'terminal')
    const hasActive = terminalTabs.some(t => t.status === 'connected')
    if (hasActive && !confirm('Close all tabs? All SSH sessions will be disconnected.')) return
    for (const tab of terminalTabs) socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tab.id })
    exitSplitMode()
    disableBroadcast()
    closeAllTabs()
  }, [socket, sessionId, closeAllTabs, exitSplitMode, disableBroadcast])

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
    const tabIds = getLayoutTabIds(root)
    for (const tabId of tabIds) {
      socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    }
    applyLayout(root)
    if (!activeTabId || !tabIds.includes(activeTabId)) setActiveTab(tabIds[0])
    setSplitOwnedByBroadcast(false)
    setSplitPickerOpen(false)
  }, [applyLayout, socket, sessionId, setActiveTab, activeTabId])

  // Broadcast: apply selected terminals + auto-layout
  const handleApplyBroadcast = useCallback((includedTabIds: string[], layout: PaneNode | null) => {
    // Set excludedTabIds = all connected tabs NOT in includedTabIds
    const allConnected = useTerminalStore.getState().tabs.filter(t => t.status === 'connected')
    const excluded = allConnected.filter(t => !includedTabIds.includes(t.id)).map(t => t.id)

    // Update broadcast store directly
    useBroadcastStore.setState({ enabled: true, excludedTabIds: excluded })

    if (layout) {
      const tabIds = getLayoutTabIds(layout)
      for (const tabId of tabIds) {
        socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
      }
      // Only take ownership of split if no split was already active
      const hadSplit = useLayoutStore.getState().root !== null
      applyLayout(layout)
      if (!activeTabId || !tabIds.includes(activeTabId)) setActiveTab(tabIds[0])
      if (!hadSplit) setSplitOwnedByBroadcast(true)
    }
    setBroadcastPickerOpen(false)
  }, [applyLayout, socket, sessionId, setActiveTab, activeTabId])

  const handleDisableBroadcast = useCallback(() => {
    disableBroadcast()
    if (splitOwnedByBroadcast) {
      exitSplitMode()
      setSplitOwnedByBroadcast(false)
    }
    setBroadcastPickerOpen(false)
  }, [disableBroadcast, exitSplitMode, splitOwnedByBroadcast])

  // Keyboard shortcuts — use refs to avoid recreating listener on every render
  const handleAddTabRef = useRef(handleAddTab)
  const handleCloseTabRef = useRef(handleCloseTab)
  const handleSetActiveTabRef = useRef(handleSetActiveTab)
  useEffect(() => {
    handleAddTabRef.current = handleAddTab
    handleCloseTabRef.current = handleCloseTab
    handleSetActiveTabRef.current = handleSetActiveTab
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); handleAddTabRef.current() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        const store = useTerminalStore.getState()
        const currentActiveTabId = store.activeTabId
        if (currentActiveTabId) {
          handleCloseTabRef.current(currentActiveTabId)
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(o => !o)
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const store = useTerminalStore.getState()
        const currentTabs = store.tabs
        const currentActiveTabId = store.activeTabId
        const idx = currentTabs.findIndex(t => t.id === currentActiveTabId)
        if (currentTabs.length > 1) {
          const next = e.shiftKey
            ? (idx - 1 + currentTabs.length) % currentTabs.length
            : (idx + 1) % currentTabs.length
          handleSetActiveTabRef.current(currentTabs[next].id)
        }
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
    () => pendingClose ? tabs.find(t => t.id === pendingClose.tabId) : undefined,
    [pendingClose, tabs]
  )

  const handleConfirmPendingClose = useCallback(() => {
    if (!pendingClose) return
    const { kind, tabId } = pendingClose
    setPendingClose(null)
    if (kind === 'pane') {
      closePaneNow(tabId)
    } else {
      closeTabNow(tabId)
    }
  }, [pendingClose, closePaneNow, closeTabNow])

  return (
    <div className="flex h-full bg-surface-950">
      <AuthRedirectOverlay />
      <SessionSidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        onLoadSession={handleLoadSession}
      />

      <div className="flex flex-col flex-1 min-w-0">
        <TabBar
          onAddTab={handleAddTab}
          onCloseTab={handleCloseTab}
          onCloneTab={handleCloneTab}
          onOpenSftpTab={handleOpenSftpTab}
          onDuplicateTab={handleDuplicateTab}
          onCloseAllTabs={handleCloseAllTabs}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSplitPicker={() => setSplitPickerOpen(true)}
          onOpenBroadcastPicker={() => setBroadcastPickerOpen(true)}
          onExitSplit={() => { exitSplitMode(); setSplitOwnedByBroadcast(false) }}
          onSetActiveTab={handleSetActiveTab}
          inSplitMode={!!layoutRoot}
        />

        <div className="flex-1 relative overflow-hidden min-h-0">
          {tabs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-500">
              <Logo size="lg" showText={false} className="opacity-40" />
              <p className="text-sm">Open a terminal tab or select a saved session from the sidebar</p>
            </div>
          ) : layoutRoot && activeTabInLayout ? (
            <div className="absolute inset-0">
              <SplitPane
                node={layoutRoot}
                socket={socket}
                onClose={handleClosePane}
                isOnlyPane={layoutRoot.type === 'leaf'}
              />
            </div>
          ) : (
            tabs.map(tab => (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{ display: tab.id === activeTabId ? 'flex' : 'none', flexDirection: 'column' }}
              >
                {tab.type === 'sftp' ? (
                  <SFTPBrowser tabId={tab.id} sourceTabId={tab.sourceTabId} socket={socket} />
                ) : (
                  <TerminalPane tabId={tab.id} isActive={tab.id === activeTabId} socket={socket} />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {splitPickerOpen && (
        <LayoutPickerModal
          tabs={tabs}
          onApply={handleApplyLayout}
          onClose={() => setSplitPickerOpen(false)}
        />
      )}

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

      {pendingClose && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
          onMouseDown={e => { if (e.target === e.currentTarget) setPendingClose(null) }}
        >
          <div className="w-80 bg-surface-900 border border-surface-700 rounded-xl shadow-2xl p-5 flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Close session?</h2>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                Closing {getTabDisplayName(pendingCloseTab)} will disconnect its SSH session.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPendingClose(null)}
                className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmPendingClose}
                autoFocus
                className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
              >
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
