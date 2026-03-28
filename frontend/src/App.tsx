import { useEffect } from 'react'
import AppLayout from './components/layout/AppLayout'
import { useServerConfigStore } from './store/serverConfigStore'

export default function App() {
  const loadServerConfig = useServerConfigStore(s => s.load)

  useEffect(() => {
    loadServerConfig()
  }, [loadServerConfig])

  return <AppLayout />
}
