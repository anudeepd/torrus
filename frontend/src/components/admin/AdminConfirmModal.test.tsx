import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminConfirmModal from './AdminConfirmModal'

describe('AdminConfirmModal', () => {
  it('ignores a mismatch and a duplicate submit while the action is running', async () => {
    let resolveAction: (() => void) | undefined
    const action = vi.fn(() => new Promise<void>(resolve => { resolveAction = resolve }))
    const onClose = vi.fn()
    render(
      <AdminConfirmModal
        request={{
          title: 'Interrupt session',
          description: 'Send Ctrl+C.',
          expected: 'INTERRUPT',
          confirmLabel: 'Send interrupt',
          action,
        }}
        onClose={onClose}
      />,
    )

    const input = screen.getByRole('textbox')
    const form = input.closest('form')!
    fireEvent.change(input, { target: { value: 'WRONG' } })
    fireEvent.submit(form)
    expect(action).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'INTERRUPT' } })
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(action).toHaveBeenCalledOnce()
    expect(input).toBeDisabled()

    resolveAction?.()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
