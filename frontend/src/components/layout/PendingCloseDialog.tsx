import type { RefObject } from 'react'
import * as m from 'motion/react-m'
import { exitTransition, fade, surface, surfaceSpring } from '@/motion/tokens'
import { useDialogPresence } from '@/hooks/useDialogPresence'

interface PendingCloseDialogProps {
  /** 'all' closes every tab, anything else closes a single tab or pane. */
  kind: 'tab' | 'pane' | 'all'
  title: string
  message: string
  /** Focused when the dialog opens; also where focus returns on close. */
  cancelRef: RefObject<HTMLButtonElement>
  onCancel: () => void
  onConfirm: () => void
}

export default function PendingCloseDialog({
  kind,
  title,
  message,
  cancelRef,
  onCancel,
  onConfirm,
}: PendingCloseDialogProps) {
  const { ref, presenceProps } = useDialogPresence(onCancel, cancelRef)
  const label = kind === 'all' ? 'Close all tabs' : 'Close tab'

  return (
    <m.div
      {...fade}
      transition={exitTransition}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}
    >
      <m.div
        {...surface}
        {...presenceProps}
        transition={surfaceSpring}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="flex w-80 flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">{message}</p>
        </div>
        <div className="flex gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md bg-surface-800 px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-surface-700 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
          >
            {label}
          </button>
        </div>
      </m.div>
    </m.div>
  )
}
