import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConnectForm from './ConnectForm'

describe('ConnectForm', () => {
  it('toggles password visibility with an app-owned control', () => {
    const onConnect = vi.fn()
    render(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    const password = screen.getByTestId('password-input')

    fireEvent.change(password, { target: { value: 'mistyped-password' } })
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('mistyped-password')

    const toggle = screen.getByRole('button', { name: 'Show password' })
    fireEvent.click(toggle)
    expect(password).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-label', 'Hide password')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(password).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAttribute('aria-label', 'Show password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
})
