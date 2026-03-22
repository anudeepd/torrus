import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SavedServer } from '@/types'

function uuid() {
  return crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
}

interface SavedServerState {
  servers: SavedServer[]

  /** Returns false if a duplicate host+port+username already exists */
  addServer: (server: Omit<SavedServer, 'id'>) => boolean
  removeServer: (id: string) => void
  /** Returns false if the update would create a duplicate */
  updateServer: (id: string, updates: Omit<SavedServer, 'id'>) => boolean
  importServers: (servers: SavedServer[], mode: 'merge' | 'replace') => void
}

export const useSavedServerStore = create<SavedServerState>()(
  persist(
    (set, get) => ({
      servers: [],

      addServer: (server) => {
        const isDuplicate = get().servers.some(
          s => s.host === server.host && s.port === server.port && s.username === server.username
        )
        if (isDuplicate) return false
        set(s => ({ servers: [...s.servers, { ...server, id: uuid() }] }))
        return true
      },

      removeServer: (id) =>
        set(s => ({ servers: s.servers.filter(srv => srv.id !== id) })),

      updateServer: (id, updates) => {
        const isDuplicate = get().servers.some(
          s => s.id !== id && s.host === updates.host && s.port === updates.port && s.username === updates.username
        )
        if (isDuplicate) return false
        set(s => ({ servers: s.servers.map(srv => srv.id === id ? { ...srv, ...updates } : srv) }))
        return true
      },

      importServers: (servers, mode) => {
        if (mode === 'replace') {
          set({ servers: servers.map(s => ({ ...s, id: uuid() })) })
        } else {
          const existing = get().servers
          const existingKeys = new Set(
            existing.map(s => `${s.host}:${s.port}:${s.username}`)
          )
          const newServers = servers
            .filter(s => !existingKeys.has(`${s.host}:${s.port}:${s.username}`))
            .map(s => ({ ...s, id: uuid() }))
          set({ servers: [...existing, ...newServers] })
        }
      },
    }),
    {
      name: 'torrus-saved-servers',
      version: 1,
    }
  )
)
