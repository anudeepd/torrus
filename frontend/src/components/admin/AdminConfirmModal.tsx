import { useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle, X } from 'lucide-react'
import * as m from 'motion/react-m'
import { useDialogPresence } from '@/hooks/useDialogPresence'
import { fade, surface, surfaceSpring } from '@/motion/tokens'

export type AdminConfirmationRequest = {
  title: string
  description: string
  expected: string
  confirmLabel: string
  destructive?: boolean
  action: () => Promise<void>
}

type AdminConfirmModalProps = {
  request: AdminConfirmationRequest
  onClose: () => void
}

export default function AdminConfirmModal({ request, onClose }: AdminConfirmModalProps) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { ref: dialogRef, presenceProps } = useDialogPresence(onClose, inputRef)
  const matches = value === request.expected

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!matches || submitting) return
    setSubmitting(true)
    try {
      await request.action()
    } finally {
      setSubmitting(false)
      onClose()
    }
  }

  return (
    <m.div
      {...fade}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={event => { if (event.target === event.currentTarget && !submitting) onClose() }}
    >
      <m.div
        {...surface}
        {...presenceProps}
        transition={surfaceSpring}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded-lg p-2 ${request.destructive ? 'bg-red-500/10 text-red-300' : 'bg-amber-500/10 text-amber-300'}`}>
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 id="admin-confirm-title" className="text-sm font-semibold text-slate-200">{request.title}</h2>
              <button type="button" onClick={onClose} disabled={submitting} className="rounded-md p-1 text-slate-500 transition-colors hover:bg-surface-800 hover:text-slate-200 disabled:opacity-40" aria-label="Close confirmation">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{request.description}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="admin-confirmation-input" className="text-xs font-medium text-slate-300">Type <span className="font-mono text-brand-300">{request.expected}</span> to confirm</label>
            <input
              ref={inputRef}
              id="admin-confirmation-input"
              type="text"
              value={value}
              onChange={event => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              className="mt-2 w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-500 focus:ring-1 focus:ring-brand-500/50 disabled:opacity-50"
              placeholder={request.expected}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md bg-surface-800 px-3 py-2 text-xs text-slate-400 transition-colors hover:bg-surface-700 hover:text-slate-200 disabled:opacity-40">Cancel</button>
            <button type="submit" disabled={!matches || submitting} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${request.destructive ? 'bg-red-600 hover:bg-red-500' : 'bg-brand-600 hover:bg-brand-500'}`}>
              {submitting && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              {submitting ? 'Working…' : request.confirmLabel}
            </button>
          </div>
        </form>
      </m.div>
    </m.div>
  )
}
