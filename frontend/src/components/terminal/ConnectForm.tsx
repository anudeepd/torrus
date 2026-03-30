import { useState, type FormEvent } from 'react'
import { Terminal } from 'lucide-react'
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
  const [localError, setLocalError] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setLocalError('')
    if (!host.trim()) { setLocalError('Host is required.'); return }
    if (!username.trim()) { setLocalError('Username is required.'); return }
    onConnect({
      host: host.trim(),
      port: parseInt(port, 10) || 22,
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
          />

          <Input
            label="Password"
            type="password"
            placeholder="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />

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
