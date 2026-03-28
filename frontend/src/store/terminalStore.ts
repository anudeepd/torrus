import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Tab, TabStatus } from '@/types'

let _tabCounter = 0

function newTabId(): string {
  _tabCounter++
  // sessionStorage persists across F5 reloads but not new browser tabs
  const key = `torrus_tab_num_${_tabCounter}`
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = `t${_tabCounter}_${Date.now()}`
    sessionStorage.setItem(key, id)
  }
  return id
}

interface TerminalState {
  sessionId: string
  tabs: Tab[]
  activeTabId: string | null

  addTab: () => string
  closeTab: (id: string) => void
  closeAllTabs: () => void
  setActiveTab: (id: string) => void
  setTabStatus: (id: string, status: TabStatus) => void
  setTabConnection: (id: string, host: string, port: number, username: string) => void
  renameTab: (id: string, label: string | null) => void
  getActiveTab: () => Tab | null
}

function uuid() {
  return crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
}

function getOrCreateSessionId(): string {
  const KEY = 'torrus_session_id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = uuid()
    localStorage.setItem(KEY, id)
  }
  return id
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessionId: getOrCreateSessionId(),
      tabs: [],
      activeTabId: null,

      addTab: () => {
        const tabId = newTabId()
        const tab: Tab = {
          id: tabId,
          host: null,
          port: null,
          username: null,
          label: null,
          status: 'disconnected',
          sessionKey: `${get().sessionId}:${tabId}`,
        }
        set(s => ({ tabs: [...s.tabs, tab], activeTabId: tabId }))
        return tabId
      },

      closeTab: (id) => {
        set(s => {
          const tabs = s.tabs.filter(t => t.id !== id)
          let activeTabId = s.activeTabId
          if (activeTabId === id) {
            activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null
          }
          return { tabs, activeTabId }
        })
      },

      closeAllTabs: () => set({ tabs: [], activeTabId: null }),

      setActiveTab: (id) => set({ activeTabId: id }),

      setTabStatus: (id, status) =>
        set(s => ({ tabs: s.tabs.map(t => t.id === id ? { ...t, status } : t) })),

      setTabConnection: (id, host, port, username) =>
        set(s => ({ tabs: s.tabs.map(t => t.id === id ? { ...t, host, port, username } : t) })),

      renameTab: (id, label) =>
        set(s => ({
          tabs: s.tabs.map(t =>
            t.id === id ? { ...t, label: label && label.trim() ? label.trim() : null } : t
          ),
        })),

      getActiveTab: () => {
        const { tabs, activeTabId } = get()
        return tabs.find(t => t.id === activeTabId) ?? null
      },
    }),
    {
      name: 'torrus-tabs',
      version: 2,
      partialize: (s) => ({
        sessionId: s.sessionId,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
      }),
    }
  )
)
