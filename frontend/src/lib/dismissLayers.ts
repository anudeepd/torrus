import { useEffect } from 'react'

/**
 * One document-level Escape handler for every dismissible layer.
 *
 * Layers form a stack: Escape dismisses the most recently opened one and stops
 * there, so a menu inside a dialog closes the menu first. Because the listener
 * only intervenes while a layer is registered, the terminal keeps receiving
 * Escape as terminal input the rest of the time.
 */
const layers: Array<() => void> = []
let installed = false

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  const top = layers[layers.length - 1]
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top()
}

function install(): void {
  if (installed) return
  installed = true
  window.addEventListener('keydown', onKeyDown, true)
}

export function useDismissLayer(active: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) return
    const layer = () => onDismiss()
    layers.push(layer)
    install()
    return () => {
      const index = layers.lastIndexOf(layer)
      if (index !== -1) layers.splice(index, 1)
    }
  }, [active, onDismiss])
}
