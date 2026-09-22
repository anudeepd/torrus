import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Keyboard behaviour shared by the tab and session context menus.
 *
 * The terminal's key capture consumes Escape and the arrow keys whenever the
 * xterm textarea has focus, so a menu must take focus on open and handle its
 * own keys — a document-level listener alone never sees them.
 */
export function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  menu: HTMLElement | null,
  onClose: () => void,
): void {
  const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLElement)

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    onClose()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(current + step + items.length) % items.length].focus()
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : items.length - 1].focus()
  }
}
