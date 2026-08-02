import { render, screen } from '@testing-library/react'
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
})
