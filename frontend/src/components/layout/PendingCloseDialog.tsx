import Dialog from '@/components/ui/Dialog'
import type { RefObject } from 'react'

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
  const label = kind === 'all' ? 'Close all tabs' : 'Close tab'

  return (
    <Dialog role="alertdialog" label={label} initialFocus={cancelRef} onClose={onCancel} className="w-80 gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-200 text-balance">{title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400 text-pretty">{message}</p>
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
    </Dialog>
  )
}
