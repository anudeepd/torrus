import { create } from 'zustand'

interface BroadcastState {
  enabled: boolean
  excludedTabIds: string[]
  toggle: () => void
  toggleTab: (tabId: string) => void
  disable: () => void
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  enabled: false,
  excludedTabIds: [],

  toggle: () => set(s => ({
    enabled: !s.enabled,
    excludedTabIds: [],
  })),

  toggleTab: (tabId) => set(s => {
    const next = s.excludedTabIds.filter(id => id !== tabId)
    if (!s.excludedTabIds.includes(tabId)) next.push(tabId)
    return { excludedTabIds: next }
  }),

  disable: () => set({ enabled: false, excludedTabIds: [] }),
}))
