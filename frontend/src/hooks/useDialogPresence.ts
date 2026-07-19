import { useIsPresent } from 'motion/react'
import type { RefObject } from 'react'
import { useModalFocus } from './useModalFocus'

export function useDialogPresence(
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const isPresent = useIsPresent()
  const ref = useModalFocus(isPresent, onClose, initialFocus)
  return {
    ref,
    isPresent,
    presenceProps: isPresent
      ? {}
      : { 'aria-hidden': true as const, inert: '' as never },
  }
}
