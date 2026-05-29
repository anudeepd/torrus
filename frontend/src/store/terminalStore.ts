import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Tab, TabStatus } from '@/types'

let _tabCounter = 0
const _pageNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function newTabId(): string {
  _tabCounter++
  const key = `torrus_tab_num_${_pageNonce}_${_tabCounter}`
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

import { uuid } from '@/utils/uuid'

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
      migrate: (persistedState: unknown, version: number) => {
        if (version < 2) {
          const s = persistedState as Record<string, unknown>
          return {
            ...s,
            tabs: (Array.isArray(s.tabs) ? s.tabs : []).map((t: Record<string, unknown>) => ({
              ...t,
              sessionKey: t.sessionKey ?? `${s.sessionId ?? ''}:${t.id ?? ''}`,
            })),
          }
        }
        return persistedState
      },
      partialize: (s) => ({
        sessionId: s.sessionId,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
      }),
    }
  )
)
