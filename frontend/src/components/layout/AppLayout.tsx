import { useState, useEffect, useCallback, useMemo } from 'react'
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
import SettingsDialog from '@/components/settings/SettingsDialog'
import type { PaneNode } from '@/store/layoutStore'
import type { SavedServer } from '@/types'

export default function AppLayout() {
  const { tabs, activeTabId, addTab, closeTab, closeAllTabs, setActiveTab, sessionId } = useTerminalStore()
  const { root: layoutRoot, closePane, exitSplitMode, applyLayout } = useLayoutStore()
  const { enabled: broadcastEnabled, excludedTabIds, disable: disableBroadcast } = useBroadcastStore()
  const socket = getSocket()

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [splitPickerOpen, setSplitPickerOpen] = useState(false)
  const [broadcastPickerOpen, setBroadcastPickerOpen] = useState(false)
  // true when split was initiated by broadcast — exiting broadcast exits split too
  const [splitOwnedByBroadcast, setSplitOwnedByBroadcast] = useState(false)

  // Warn before close/reload if any active SSH sessions
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasActive = useTerminalStore.getState().tabs.some(t => t.status === 'connected')
      if (!hasActive) return
      e.preventDefault()
      e.returnValue = 'You have active SSH sessions. Leave anyway?'
      return e.returnValue
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Register all tabs on socket connect
  useEffect(() => {
    const onConnect = () => {
      const { tabs: currentTabs, sessionId: sid } = useTerminalStore.getState()
      for (const tab of currentTabs) {
        socket.emit('session:register', { session_id: sid, tab_id: tab.id })
      }
    }
    socket.on('connect', onConnect)
    if (socket.connected) onConnect()
    return () => { socket.off('connect', onConnect) }
  }, [socket])

  // Open first tab if none exist
  useEffect(() => {
    if (tabs.length === 0) addTab()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddTab = useCallback(() => {
    const tabId = addTab()
    if (socket.connected) {
      socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    }
  }, [addTab, socket, sessionId])

  const handleClosePane = useCallback((tabId: string) => {
    const { root } = useLayoutStore.getState()
    if (!root) return
    const remaining = getLayoutTabIds(root).filter(id => id !== tabId)
    if (remaining.length <= 1) {
      exitSplitMode()
      if (remaining[0]) setActiveTab(remaining[0])
    } else {
      closePane(tabId)
    }
  }, [closePane, exitSplitMode, setActiveTab])

  const handleCloseTab = useCallback((id: string) => {
    socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: id })
    const { root } = useLayoutStore.getState()
    if (root && getLayoutTabIds(root).includes(id)) handleClosePane(id)
    closeTab(id)
    if (tabs.length === 1) {
      setTimeout(() => {
        if (useTerminalStore.getState().tabs.length === 0) addTab()
      }, 0)
    }
  }, [socket, sessionId, closeTab, tabs.length, addTab, handleClosePane])

  const handleCloneTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || sourceTab.status !== 'connected' || !sourceTab.host || !sourceTab.username) return
    const newTabId = addTab()
    if (socket.connected) socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host, sourceTab.port ?? 22, sourceTab.username)
    const baseName = sourceTab.label ?? `${sourceTab.username}@${sourceTab.host}`
    store.renameTab(newTabId, `${baseName} (clone)`)
    store.setTabStatus(newTabId, 'connecting')
    socket.emit('ssh:clone', {
      session_id: sessionId, source_tab_id: sourceTabId, new_tab_id: newTabId, cols: 220, rows: 50,
    })
  }, [addTab, socket, sessionId])

  const handleCloseAllTabs = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    const hasActive = currentTabs.some(t => t.status === 'connected')
    if (hasActive && !confirm('Close all tabs? All SSH sessions will be disconnected.')) return
    for (const tab of currentTabs) socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tab.id })
    exitSplitMode()
    disableBroadcast()
    closeAllTabs()
  }, [socket, sessionId, closeAllTabs, exitSplitMode, disableBroadcast])

  const handleDuplicateTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || !sourceTab.host || !sourceTab.username) return
    const newTabId = addTab()
    if (socket.connected) socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host, sourceTab.port ?? 22, sourceTab.username)
    if (sourceTab.label) store.renameTab(newTabId, sourceTab.label)
  }, [addTab, socket, sessionId])

  const handleLoadSession = useCallback((server: SavedServer) => {
    const tabId = addTab()
    if (socket.connected) socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    const store = useTerminalStore.getState()
    store.setTabConnection(tabId, server.host, server.port, server.username)
    store.renameTab(tabId, server.name)
  }, [addTab, socket, sessionId])

  // Apply a layout from the Split picker (manual split, broadcast does not own it)
  const handleApplyLayout = useCallback((root: PaneNode) => {
    const tabIds = getLayoutTabIds(root)
    for (const tabId of tabIds) {
      if (socket.connected) socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    }
    applyLayout(root)
    setSplitOwnedByBroadcast(false)
    setSplitPickerOpen(false)
  }, [applyLayout, socket, sessionId])

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
        if (socket.connected) socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
      }
      // Only take ownership of split if no split was already active
      const hadSplit = useLayoutStore.getState().root !== null
      applyLayout(layout)
      if (!hadSplit) setSplitOwnedByBroadcast(true)
    }
    setBroadcastPickerOpen(false)
  }, [applyLayout, socket, sessionId])

  const handleDisableBroadcast = useCallback(() => {
    disableBroadcast()
    if (splitOwnedByBroadcast) {
      exitSplitMode()
      setSplitOwnedByBroadcast(false)
    }
    setBroadcastPickerOpen(false)
  }, [disableBroadcast, exitSplitMode, splitOwnedByBroadcast])

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); handleAddTab() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        if (activeTabId) {
          const tab = tabs.find(t => t.id === activeTabId)
          if (tab?.status === 'connected') {
            if (!confirm('Close this tab? The SSH session will be disconnected.')) return
          }
          handleCloseTab(activeTabId)
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(o => !o)
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const idx = tabs.findIndex(t => t.id === activeTabId)
        if (tabs.length > 1) {
          const next = e.shiftKey
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length
          setActiveTab(tabs[next].id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleAddTab, handleCloseTab, activeTabId, tabs, setActiveTab])

  const connectedTabs = useMemo(() => tabs.filter(t => t.status === 'connected'), [tabs])
  const broadcastIncluded = useMemo(
    () => new Set(connectedTabs.filter(t => !excludedTabIds.includes(t.id)).map(t => t.id)),
    [connectedTabs, excludedTabIds]
  )

  return (
    <div className="flex h-full bg-surface-950">
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
          onDuplicateTab={handleDuplicateTab}
          onCloseAllTabs={handleCloseAllTabs}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSplitPicker={() => setSplitPickerOpen(true)}
          onOpenBroadcastPicker={() => setBroadcastPickerOpen(true)}
          onExitSplit={() => { exitSplitMode(); setSplitOwnedByBroadcast(false) }}
          inSplitMode={!!layoutRoot}
        />

        <div className="flex-1 relative overflow-hidden min-h-0">
          {layoutRoot ? (
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
                <TerminalPane tabId={tab.id} isActive={tab.id === activeTabId} socket={socket} />
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
    </div>
  )
}
