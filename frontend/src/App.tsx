import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import AdminConsole from './components/admin/AdminConsole'
import AppLayout from './components/layout/AppLayout'
import { spatialTransition } from './motion/tokens'
import { useServerConfigStore } from './store/serverConfigStore'
import { redirectToLdapLogin } from './utils/authRedirect'
import { startAuthIdleTimer } from './utils/authIdleTimer'

export default function App() {
  const loadServerConfig = useServerConfigStore(s => s.load)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const ldapIdleTimeout = useServerConfigStore(s => s.ldapIdleTimeout)
  const [isAdminRoute, setIsAdminRoute] = useState(() => window.location.pathname === '/admin')

  useEffect(() => {
    loadServerConfig()
  }, [loadServerConfig])

  useEffect(() => {
    const handlePopState = () => setIsAdminRoute(window.location.pathname === '/admin')
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => startAuthIdleTimer({
    enabled: ldapEnabled,
    idleTimeoutSeconds: ldapIdleTimeout,
    onIdle: redirectToLdapLogin,
  }), [ldapEnabled, ldapIdleTimeout])

  const navigateToAdmin = () => {
    window.history.pushState({}, '', '/admin')
    setIsAdminRoute(true)
  }

  const closeAdmin = () => {
    window.history.pushState({}, '', '/')
    setIsAdminRoute(false)
  }

  return (
    <AnimatePresence initial={false} mode="wait">
      {isAdminRoute ? (
        <m.div
          key="admin"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={spatialTransition}
          className="h-full"
        >
          <AdminConsole onClose={closeAdmin} />
        </m.div>
      ) : (
        <m.div
          key="terminal"
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={spatialTransition}
          className="h-full"
        >
          <AppLayout navigateToAdmin={navigateToAdmin} />
        </m.div>
      )}
    </AnimatePresence>
  )
}
