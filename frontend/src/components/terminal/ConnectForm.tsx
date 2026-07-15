import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, Terminal } from 'lucide-react'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import type { ConnectFormValues } from '@/types'

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
    <div className="flex items-center justify-center h-full bg-surface-950">
      <div className="w-80 bg-surface-900 border border-surface-700 rounded-xl p-6 flex flex-col gap-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-200">SSH Connection</h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
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
            <div className="w-24">
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
              className="pr-10"
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

          {displayError && (
            <p className="text-xs text-red-400 text-center">{displayError}</p>
          )}

          <Button type="submit" variant="primary" size="lg" className="w-full mt-1">
            Connect
          </Button>
        </form>
      </div>
    </div>
  )
}
