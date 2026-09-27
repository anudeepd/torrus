import type { ReactNode, RefObject } from 'react'
import { cn } from '@/lib/cn'
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
 * `className` carries width, padding and internal layout. The panel merges its
 * classes through `cn`, so a consumer's class replaces the default it collides
 * with — `w-80` supersedes the panel's `w-full`, `p-0` supersedes its `p-5` — and
 * no `!important` marker is needed.
 *
 * The panel is the scroll container for a long dialog, so it contains overscroll
 * rather than chaining the scroll to the page behind it.
 *
 * The layer is fixed, so the `html` safe-area padding in `index.css` does not
 * move it — it carries its own `env(safe-area-inset-*)` padding instead.
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
      className={cn(
        'fixed inset-0 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]',
        LAYER_CLASS[layer],
        align === 'top'
          ? 'items-start pt-[max(min(22dvh,9rem),env(safe-area-inset-top))]'
          : 'items-center',
      )}
      onMouseDown={event => { if (dismissable && event.target === event.currentTarget) onClose() }}
    >
      <div
        aria-hidden="true"
        className={cn('pointer-events-none absolute inset-0', scrimClassName ?? 'bg-black/60')}
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
        className={cn(
          'relative flex w-full flex-col overscroll-contain rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl',
          className,
        )}
      >
        {children}
      </m.div>
    </m.div>
  )
}
