import type { ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import { useDialogPresence } from '@/hooks/useDialogPresence'
import { exitTransition, fade, surface, surfaceSpring } from '@/motion/tokens'
import * as m from 'motion/react-m'

/** Static so Tailwind emits the class. */
const LAYER_CLASS: Record<NonNullable<DialogProps['layer']>, string> = {
  dialog: 'z-dialog',
  confirm: 'z-confirm',
  overlay: 'z-overlay',
}

interface DialogProps {
  onClose: () => void
  children: ReactNode
  /** `alertdialog` for confirmations of destructive or irreversible actions. */
  role?: 'dialog' | 'alertdialog'
  /** Accessible name, or `labelledBy` pointing at the heading inside. */
  label?: string
  labelledBy?: string
  initialFocus?: RefObject<HTMLElement | null>
  /** Panel classes: width, padding and internal layout. */
  className?: string
  scrimClassName?: string
  align?: 'center' | 'top'
  /** Layer within the z-index scale, so stacked dialogs keep their order. */
  layer?: 'dialog' | 'confirm' | 'overlay'
  /** False while a submit is in flight, so a stray click cannot dismiss it. */
  dismissable?: boolean
}

/**
 * The one modal shell: overlay, scrim, panel, focus trap, Escape, and the
 * enter/exit transitions. Every dialog in the app renders through this, so
 * focus, layering and reduced motion are fixed in one place.
 *
 * `className` carries width, padding and internal layout. The panel's `p-5` is
 * the default for a dialog that does not set its own padding; because classes
 * are concatenated rather than merged, a consumer that wants a different
 * padding must mark it important (`!p-0`, `!p-6`) — otherwise `p-5` wins on
 * stylesheet order regardless of where it appears in `className`.
 */
export default function Dialog({
  onClose,
  children,
  role = 'dialog',
  label,
  labelledBy,
  initialFocus,
  className,
  scrimClassName,
  align = 'center',
  layer = 'dialog',
  dismissable = true,
}: DialogProps) {
  const { ref, presenceProps } = useDialogPresence(onClose, initialFocus)

  return (
    <m.div
      {...fade}
      transition={exitTransition}
      className={clsx(
        'fixed inset-0 flex justify-center p-4',
        LAYER_CLASS[layer],
        align === 'top' ? 'items-start pt-[min(22vh,9rem)]' : 'items-center',
      )}
      onMouseDown={event => { if (dismissable && event.target === event.currentTarget) onClose() }}
    >
      <div
        aria-hidden="true"
        className={clsx('pointer-events-none absolute inset-0', scrimClassName ?? 'bg-black/60')}
      />
      <m.div
        {...surface}
        {...presenceProps}
        transition={surfaceSpring}
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={clsx(
          'relative flex w-full flex-col rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl',
          className,
        )}
      >
        {children}
      </m.div>
    </m.div>
  )
}
