import { create } from 'zustand'
import { redirectToLdapLogin } from '@/utils/authRedirect'

interface ServerConfigState {
  ldapEnabled: boolean
  load: () => Promise<void>
}

export const useServerConfigStore = create<ServerConfigState>((set) => ({
  ldapEnabled: false,
  load: async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch('/api/config', { signal: controller.signal })
      clearTimeout(timeout)
      if (res.status === 401) {
        redirectToLdapLogin()
        return
      }
      if (!res.ok) return
      const config = await res.json()
      set({ ldapEnabled: Boolean(config.ldap_enabled) })
    } catch {
      clearTimeout(timeout)
    }
  },
}))
