const MODIFIER_KEYS: Record<string, true> = {
  Shift: true, Control: true, Alt: true, Meta: true, AltGraph: true, CapsLock: true,
}
const NAVIGATION_KEYS: Record<string, true> = {
  Tab: true, ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true,
  Home: true, End: true, PageUp: true, PageDown: true, Enter: true, ' ': true, Escape: true,
}

/** Modifier-only gestures must not reveal focus left behind by a pointer. */
export function installFocusModality(doc: Document = document): () => void {
  const root = doc.documentElement
  root.dataset.focusModality = 'keyboard'

  const onPointerDown = () => { root.dataset.focusModality = 'pointer' }
  const onKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS[event.key]) return
    // Keep modified navigation (notably Alt+Arrow tab reordering), but do not
    // reinterpret terminal shortcuts such as Ctrl+C as focus navigation.
    if ((event.metaKey || event.ctrlKey || event.altKey) && !NAVIGATION_KEYS[event.key]) return
    root.dataset.focusModality = 'keyboard'
  }

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown, true)
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onKeyDown, true)
    delete root.dataset.focusModality
  }
}
