import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModalFocus } from './useModalFocus'

function TestDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalFocus(true, onClose)
  return (
    <div ref={dialogRef} role="dialog" tabIndex={-1}>
      <p>alice</p>
      <input aria-label="Confirmation" />
    </div>
  )
}

function EmptyDialog() {
  const dialogRef = useModalFocus(true, () => {})
  return <div ref={dialogRef} role="dialog" tabIndex={-1}><p>nothing focusable</p></div>
}

function TwoButtonDialog() {
  const dialogRef = useModalFocus(true, () => {})
  return (
    <div ref={dialogRef} role="dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Second</button>
    </div>
  )
}

describe('useModalFocus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not refocus modal when parent changes callback identity', async () => {
    const { rerender } = render(<TestDialog onClose={() => {}} />)
    const input = screen.getByRole('textbox', { name: 'Confirmation' })

    await vi.waitFor(() => expect(input).toHaveFocus())
    const focus = vi.spyOn(input, 'focus')
    const selection = window.getSelection()
    const source = screen.getByText('alice')
    const range = document.createRange()
    range.selectNodeContents(source)
    selection?.removeAllRanges()
    selection?.addRange(range)

    rerender(<TestDialog onClose={() => {}} />)

    expect(focus).not.toHaveBeenCalled()
    expect(selection?.toString()).toBe('alice')
  })

  it('focuses the dialog itself when it has no focusable controls', async () => {
    render(<EmptyDialog />)
    const dialog = screen.getByRole('dialog')
    await vi.waitFor(() => expect(dialog).toHaveFocus())
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(dialog).toHaveFocus()
  })

  it('wraps Tab and Shift+Tab through the dialog controls', async () => {
    render(<TwoButtonDialog />)
    const first = screen.getByRole('button', { name: 'First' })
    const second = screen.getByRole('button', { name: 'Second' })
    await vi.waitFor(() => expect(first).toHaveFocus())

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(first).toHaveFocus()
  })

  it('does not remember a non-HTML return focus target', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')!
    let first = true
    vi.spyOn(document, 'activeElement', 'get').mockImplementation(() => {
      if (first) {
        first = false
        return svg
      }
      return descriptor.get!.call(document)
    })
    render(<TestDialog onClose={() => {}} />)
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Confirmation' })).toHaveFocus())
  })
})
