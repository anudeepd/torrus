import { create } from 'zustand'

interface BroadcastState {
  enabled: boolean
  excludedTabIds: string[]
  /** Whether the current split layout was opened by broadcast (not the user),
   * so leaving it for a tab outside the layout should tear the split down. */
  splitOwned: boolean
  toggle: () => void
  toggleTab: (tabId: string) => void
  disable: () => void
  setSplitOwned: (owned: boolean) => void
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  enabled: false,
  excludedTabIds: [],
  splitOwned: false,

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

  setSplitOwned: (owned) => set({ splitOwned: owned }),
}))
