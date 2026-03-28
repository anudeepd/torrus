import { useState, useEffect, useCallback } from 'react'
import { getSocket } from '@/hooks/useSocket'
import { useTerminalStore } from '@/store/terminalStore'
import TabBar from './TabBar'
import SessionSidebar from './SessionSidebar'
import TerminalPane from '@/components/terminal/TerminalPane'
import SettingsDialog from '@/components/settings/SettingsDialog'
import type { SavedServer } from '@/types'

export default function AppLayout() {
  const { tabs, activeTabId, addTab, closeTab, closeAllTabs, setActiveTab, sessionId } = useTerminalStore()
  const socket = getSocket()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  const handleCloseTab = useCallback((id: string) => {
    socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: id })
    closeTab(id)
    if (tabs.length === 1) {
      setTimeout(() => {
        if (useTerminalStore.getState().tabs.length === 0) addTab()
      }, 0)
    }
  }, [socket, sessionId, closeTab, tabs.length, addTab])

  const handleCloneTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || sourceTab.status !== 'connected') return

    const newTabId = addTab()
    if (socket.connected) {
      socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    }

    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host!, sourceTab.port ?? 22, sourceTab.username!)
    store.renameTab(newTabId, sourceTab.label ? `${sourceTab.label} (clone)` : null)
    store.setTabStatus(newTabId, 'connecting')

    socket.emit('ssh:clone', {
      session_id: sessionId,
      source_tab_id: sourceTabId,
      new_tab_id: newTabId,
      cols: 220,
      rows: 50,
    })
  }, [addTab, socket, sessionId])

  const handleCloseAllTabs = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    const hasActive = currentTabs.some(t => t.status === 'connected')
    if (hasActive && !confirm('Close all tabs? All SSH sessions will be disconnected.')) return
    for (const tab of currentTabs) {
      socket.emit('ssh:disconnect', { session_id: sessionId, tab_id: tab.id })
    }
    closeAllTabs()
  }, [socket, sessionId, closeAllTabs])

  const handleDuplicateTab = useCallback((sourceTabId: string) => {
    const sourceTab = useTerminalStore.getState().tabs.find(t => t.id === sourceTabId)
    if (!sourceTab || !sourceTab.host) return

    const newTabId = addTab()
    if (socket.connected) {
      socket.emit('session:register', { session_id: sessionId, tab_id: newTabId })
    }

    const store = useTerminalStore.getState()
    store.setTabConnection(newTabId, sourceTab.host, sourceTab.port ?? 22, sourceTab.username!)
    if (sourceTab.label) store.renameTab(newTabId, sourceTab.label)
  }, [addTab, socket, sessionId])

  const handleLoadSession = useCallback((server: SavedServer) => {
    const tabId = addTab()
    if (socket.connected) {
      socket.emit('session:register', { session_id: sessionId, tab_id: tabId })
    }
    // Pre-populate the tab so ConnectForm shows the right initial values
    const store = useTerminalStore.getState()
    store.setTabConnection(tabId, server.host, server.port, server.username)
    store.renameTab(tabId, server.name)
  }, [addTab, socket, sessionId])

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

  return (
    <div className="flex h-full bg-surface-950">
      {/* Sessions sidebar */}
      <SessionSidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        onLoadSession={handleLoadSession}
      />

      {/* Main area: tab bar + terminals */}
      <div className="flex flex-col flex-1 min-w-0">
        <TabBar
          onAddTab={handleAddTab}
          onCloseTab={handleCloseTab}
          onCloneTab={handleCloneTab}
          onDuplicateTab={handleDuplicateTab}
          onCloseAllTabs={handleCloseAllTabs}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="flex-1 relative overflow-hidden min-h-0">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === activeTabId ? 'flex' : 'none', flexDirection: 'column' }}
            >
              <TerminalPane
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                socket={socket}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Settings dialog */}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
