import { create } from 'zustand'
import { redirectToLdapLogin } from '@/utils/authRedirect'

interface ServerConfigState {
  ldapEnabled: boolean
  ldapIdleTimeout: number
  load: () => Promise<void>
}

export const useServerConfigStore = create<ServerConfigState>((set) => ({
  ldapEnabled: false,
  ldapIdleTimeout: 0,
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
      const idleTimeout = Number(config.ldap_idle_timeout)
      set({
        ldapEnabled: Boolean(config.ldap_enabled),
        ldapIdleTimeout: Number.isFinite(idleTimeout) ? Math.max(0, idleTimeout) : 0,
      })
    } catch {
      clearTimeout(timeout)
    }
  },
}))
