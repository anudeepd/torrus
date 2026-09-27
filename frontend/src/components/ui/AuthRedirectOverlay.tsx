import { useEffect, useRef, useState } from 'react'
import {
  AUTH_LOGOUT_EVENT,
  AUTH_REDIRECT_EVENT,
  redirectToLdapLoginNow,
} from '@/utils/authRedirect'
import * as m from 'motion/react-m'
import { fade, surface, surfaceSpring } from '@/motion/tokens'

type AuthOverlayMode = 'expired' | 'logout'

const COPY: Record<AuthOverlayMode, { title: string; message: string; action?: string }> = {
  expired: {
    title: 'Session expired',
    message: 'Your session has ended. Redirecting to sign in…',
    action: 'Sign in now',
  },
  logout: {
    title: 'Signing out',
    message: 'Ending your session…',
  },
}

export default function AuthRedirectOverlay() {
  const [mode, setMode] = useState<AuthOverlayMode | null>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const showExpired = () => setMode('expired')
    const showLogout = () => setMode('logout')
    window.addEventListener(AUTH_REDIRECT_EVENT, showExpired)
    window.addEventListener(AUTH_LOGOUT_EVENT, showLogout)
    return () => {
      window.removeEventListener(AUTH_REDIRECT_EVENT, showExpired)
      window.removeEventListener(AUTH_LOGOUT_EVENT, showLogout)
    }
  }, [])

  // The overlay appears after an async auth event, so it takes focus itself:
  // the action when there is one, the panel otherwise (its copy is announced).
  useEffect(() => {
    if (!mode) return
    ;(actionRef.current ?? panelRef.current)?.focus()
  }, [mode])

  if (!mode) return null

  const copy = COPY[mode]
  const hasAction = Boolean(copy.action)

  return (
    <m.div {...fade} className="fixed inset-0 z-overlay flex items-center justify-center bg-slate-950/70 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* The blur lives on a static child: this layer's opacity is animated, and
          animating a full-viewport backdrop-filter is expensive. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 backdrop-blur-sm" />
      <m.div
        key={mode}
        {...surface}
        transition={surfaceSpring}
        ref={panelRef}
        tabIndex={-1}
        role="alert"
        aria-live="polite"
        className="relative w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl"
      >
        <div className={hasAction ? 'mb-4 flex items-center gap-3' : 'flex items-center gap-3'}>
          <div className="size-9 rounded-full border border-brand-500/40 bg-brand-500/10 p-2">
            <div className="h-full w-full animate-pulse rounded-full bg-brand-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100 text-balance">{copy.title}</h2>
            <p className="mt-1 text-xs text-slate-400 text-pretty">{copy.message}</p>
          </div>
        </div>
        {hasAction && (
          <button
            type="button"
            ref={actionRef}
            onClick={redirectToLdapLoginNow}
            className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {copy.action}
          </button>
        )}
      </m.div>
    </m.div>
  )
}
