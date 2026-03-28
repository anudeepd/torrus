import { create } from 'zustand'

interface ServerConfigState {
  ldapEnabled: boolean
  load: () => Promise<void>
}

export const useServerConfigStore = create<ServerConfigState>((set) => ({
  ldapEnabled: false,
  load: async () => {
    try {
      const res = await fetch('/api/config')
      if (!res.ok) return
      const config = await res.json()
      set({ ldapEnabled: Boolean(config.ldap_enabled) })
    } catch {
      // silently ignore — ldap stays false
    }
  },
}))
