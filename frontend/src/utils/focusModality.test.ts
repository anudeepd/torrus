import { afterEach, describe, expect, it } from 'vitest'
import { installFocusModality } from './focusModality'

let uninstall: (() => void) | undefined

afterEach(() => { uninstall?.() })

describe('focus modality', () => {
  it('does not turn pointer focus into keyboard focus for modifier-only gestures', () => {
    const doc = document.implementation.createHTMLDocument()
    uninstall = installFocusModality(doc)
    doc.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      doc.body.dispatchEvent(event)
      expect(doc.documentElement.dataset.focusModality).toBe('pointer')
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it.each([
    { key: 'Tab', shiftKey: true },
    { key: 'ArrowRight', altKey: true },
    { key: 'Home', ctrlKey: true },
  ])('restores keyboard focus for navigation: $key', options => {
    const doc = document.implementation.createHTMLDocument()
    uninstall = installFocusModality(doc)
    doc.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
    doc.body.dispatchEvent(event)
    expect(doc.documentElement.dataset.focusModality).toBe('keyboard')
    expect(event.defaultPrevented).toBe(false)
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    expect(doc.documentElement.dataset.focusModality).toBe('keyboard')
  })

  it.each([
    { key: 'c', ctrlKey: true },
    { key: 'v', metaKey: true },
    { key: 'b', altKey: true },
  ])('leaves terminal shortcuts alone: $key', options => {
    const doc = document.implementation.createHTMLDocument()
    const terminalInput = doc.createElement('textarea')
    doc.body.append(terminalInput)
    uninstall = installFocusModality(doc)
    terminalInput.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
    terminalInput.dispatchEvent(event)
    expect(doc.documentElement.dataset.focusModality).toBe('pointer')
    expect(event.defaultPrevented).toBe(false)
  })
})
