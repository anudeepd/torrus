import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, Terminal } from 'lucide-react'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import type { ConnectFormValues } from '@/types'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { fade, surface, surfaceSpring } from '@/motion/tokens'

interface ConnectFormProps {
  initialHost?: string
  initialPort?: number
  initialUsername?: string
  error?: string
  onConnect: (values: ConnectFormValues) => void
}

export default function ConnectForm({
  initialHost, initialPort, initialUsername, error, onConnect,
}: ConnectFormProps) {
  const [host, setHost] = useState(initialHost ?? '')
  const [port, setPort] = useState(initialPort?.toString() ?? '22')
  const [username, setUsername] = useState(initialUsername ?? '')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [localError, setLocalError] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setLocalError('')
    if (!host.trim()) { setLocalError('Host is required.'); return }
    if (!username.trim()) { setLocalError('Username is required.'); return }
    const parsedPort = parseInt(port, 10)
    if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setLocalError('Port must be 1-65535.')
      return
    }
    onConnect({
      host: host.trim(),
      port: parsedPort,
      username: username.trim(),
      password,
    })
  }

  const displayError = localError || error

  return (
    <m.div {...fade} className="torrus-connect-container flex h-full items-center justify-center bg-surface-950">
      <m.div {...surface} transition={surfaceSpring} className="torrus-connect-card flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-brand-400" />
          <h2 className="torrus-connect-title whitespace-nowrap text-xs font-semibold text-slate-200">SSH Connection</h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="torrus-connect-endpoint flex flex-col gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label="Host"
                placeholder="hostname or IP"
                value={host}
                onChange={e => setHost(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="host-input"
              />
            </div>
            <div className="torrus-connect-port w-full">
              <Input
                label="Port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
                data-testid="port-input"
              />
            </div>
          </div>

          <Input
            label="Username"
            placeholder="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            data-testid="username-input"
          />

          <div className="relative">
            <Input
              label="Password"
              type={passwordVisible ? 'text' : 'password'}
              placeholder="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="torrus-password-input pr-10"
              data-testid="password-input"
            />
            <button
              type="button"
              onClick={() => setPasswordVisible(visible => !visible)}
              className="absolute right-2 top-[26px] rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={passwordVisible ? 'Hide password' : 'Show password'}
              aria-pressed={passwordVisible}
            >
              {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <AnimatePresence initial={false}>
            {displayError && (
              <m.p initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xs text-red-400 text-center">{displayError}</m.p>
            )}
          </AnimatePresence>

          <Button type="submit" variant="primary" size="md" className="w-full mt-1">
            Connect
          </Button>
        </form>
      </m.div>
    </m.div>
  )
}
