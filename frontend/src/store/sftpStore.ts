import { create } from 'zustand'
import type { SFTPEntry } from '@/types'

export type TransferStatus = 'queued' | 'active' | 'done' | 'error'
export type TransferDirection = 'upload' | 'download'

export interface TransferItem {
  id: string
  tabId: string
  name: string
  direction: TransferDirection
  status: TransferStatus
  progress: number
  bytes: number
  total: number
  startedAt: number
  error?: string
}

interface SFTPTabState {
  path: string
  username: string | null
  isRoot: boolean
  entries: SFTPEntry[]
  selectedPaths: string[]
  loading: boolean
  error: string | null
  disconnected: boolean
}

interface SFTPStore {
  tabs: Record<string, SFTPTabState>
  transfers: TransferItem[]
  ensureTab: (tabId: string) => void
  setListing: (tabId: string, path: string, entries: SFTPEntry[]) => void
  setUsername: (tabId: string, username: string | null) => void
  setIsRoot: (tabId: string, isRoot: boolean) => void
  setLoading: (tabId: string, loading: boolean) => void
  setError: (tabId: string, error: string | null) => void
  setDisconnected: (tabId: string, disconnected: boolean) => void
  toggleSelected: (tabId: string, path: string, range?: string[]) => void
  setSelected: (tabId: string, paths: string[]) => void
  clearSelected: (tabId: string) => void
  addTransfer: (item: Omit<TransferItem, 'startedAt'>) => void
  updateTransfer: (id: string, patch: Partial<TransferItem>) => void
  removeTransfer: (id: string) => void
  activeTransferCount: () => number
}

const emptyTab = (): SFTPTabState => ({
  path: '.',
  username: null,
  isRoot: false,
  entries: [],
  selectedPaths: [],
  loading: false,
  error: null,
  disconnected: false,
})

export const useSFTPStore = create<SFTPStore>((set, get) => ({
  tabs: {},
  transfers: [],

  ensureTab: (tabId) =>
    set(s => ({ tabs: s.tabs[tabId] ? s.tabs : { ...s.tabs, [tabId]: emptyTab() } })),

  setListing: (tabId, path, entries) =>
    set(s => ({
      tabs: {
        ...s.tabs,
        [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), path, entries, loading: false, error: null, selectedPaths: [] },
      },
    })),

  setUsername: (tabId, username) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), username } } })),

  setIsRoot: (tabId, isRoot) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), isRoot } } })),

  setLoading: (tabId, loading) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), loading } } })),

  setError: (tabId, error) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), error, loading: false } } })),

  setDisconnected: (tabId, disconnected) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), disconnected, loading: false } } })),

  toggleSelected: (tabId, path, range) =>
    set(s => {
      const tab = s.tabs[tabId] ?? emptyTab()
      const selected = new Set(tab.selectedPaths)
      if (range?.length) {
        for (const item of range) selected.add(item)
      } else if (selected.has(path)) {
        selected.delete(path)
      } else {
        selected.add(path)
      }
      return { tabs: { ...s.tabs, [tabId]: { ...tab, selectedPaths: [...selected] } } }
    }),

  setSelected: (tabId, paths) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), selectedPaths: paths } } })),

  clearSelected: (tabId) =>
    set(s => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? emptyTab()), selectedPaths: [] } } })),

  addTransfer: (item) =>
    set(s => ({ transfers: [...s.transfers, { ...item, startedAt: Date.now() }] })),

  updateTransfer: (id, patch) =>
    set(s => ({ transfers: s.transfers.map(t => t.id === id ? { ...t, ...patch } : t) })),

  removeTransfer: (id) =>
    set(s => ({ transfers: s.transfers.filter(t => t.id !== id) })),

  activeTransferCount: () => get().transfers.filter(t => t.status === 'active').length,
}))
