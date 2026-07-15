import { useEffect } from 'react'
import AppLayout from './components/layout/AppLayout'
import { useServerConfigStore } from './store/serverConfigStore'
import { redirectToLdapLogin } from './utils/authRedirect'
import { startAuthIdleTimer } from './utils/authIdleTimer'

export default function App() {
  const loadServerConfig = useServerConfigStore(s => s.load)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const ldapIdleTimeout = useServerConfigStore(s => s.ldapIdleTimeout)

  useEffect(() => {
    loadServerConfig()
  }, [loadServerConfig])

  useEffect(() => startAuthIdleTimer({
    enabled: ldapEnabled,
    idleTimeoutSeconds: ldapIdleTimeout,
    onIdle: redirectToLdapLogin,
  }), [ldapEnabled, ldapIdleTimeout])

  return <AppLayout />
}
