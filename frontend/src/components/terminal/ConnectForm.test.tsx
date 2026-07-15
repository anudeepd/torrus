import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConnectForm from './ConnectForm'

describe('ConnectForm', () => {
  it('reveals an entered password after a connection error so it can be corrected', () => {
    const onConnect = vi.fn()
    const { rerender } = render(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    const password = screen.getByTestId('password-input')

    fireEvent.change(password, { target: { value: 'mistyped-password' } })
    rerender(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))

    expect(password).toHaveAttribute('type', 'text')
    expect(password).toHaveValue('mistyped-password')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
  })
})
