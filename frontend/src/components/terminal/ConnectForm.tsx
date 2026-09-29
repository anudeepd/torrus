import { useId, useRef, useState, type FormEvent } from 'react'
import { Terminal } from 'lucide-react'
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
  const [localError, setLocalError] = useState('')
  const formErrorId = useId()
  const hostRef = useRef<HTMLInputElement>(null)
  const portRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)

  // Validation copy stays form-level (one line, role="alert", linked through
  // aria-describedby), but focus moves to the field that failed so the fix is
  // one keystroke away instead of a re-tab from the top.
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setLocalError('')
    if (!host.trim()) {
      setLocalError('Host is required.')
      hostRef.current?.focus()
      return
    }
    if (!username.trim()) {
      setLocalError('Username is required.')
      usernameRef.current?.focus()
      return
    }
    const parsedPort = parseInt(port, 10)
    if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setLocalError('Port must be 1-65535.')
      portRef.current?.focus()
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
  const errorFieldProps = displayError
    ? { 'aria-invalid': true as const, 'aria-describedby': formErrorId }
    : {}

  return (
    <m.div {...fade} className="torrus-connect-container flex h-full items-center justify-center bg-surface-950">
      <m.div {...surface} transition={surfaceSpring} className="torrus-connect-card flex w-96 max-w-[calc(100%-1.5rem)] flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <Terminal aria-hidden="true" className="size-5 text-brand-400" />
          <h2 className="torrus-connect-title whitespace-nowrap text-balance text-xs font-semibold text-slate-200">SSH connection</h2>
        </div>

        <form
          onSubmit={handleSubmit}
          onKeyDown={event => {
            if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
            event.preventDefault()
            event.currentTarget.requestSubmit()
          }}
          className="flex flex-col gap-3"
        >
          <div className="torrus-connect-endpoint flex flex-col gap-2">
            <div className="min-w-0 flex-1">
              <Input
                ref={hostRef}
                label="Host"
                name="host"
                placeholder="hostname or IP…"
                value={host}
                onChange={e => setHost(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="host-input"
                {...errorFieldProps}
              />
            </div>
            <div className="torrus-connect-port w-full">
              <Input
                ref={portRef}
                label="Port"
                name="port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
                autoComplete="off"
                data-testid="port-input"
                {...errorFieldProps}
              />
            </div>
          </div>

          <Input
            ref={usernameRef}
            label="Username"
            name="username"
            placeholder="username…"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            data-testid="username-input"
            {...errorFieldProps}
          />

          <Input
            label="Password"
            name="password"
            type="password"
            placeholder="password…"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            data-testid="password-input"
            {...errorFieldProps}
          />

          <AnimatePresence initial={false}>
            {displayError && (
              <m.p id={formErrorId} role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xs text-red-400 text-center">{displayError}</m.p>
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
