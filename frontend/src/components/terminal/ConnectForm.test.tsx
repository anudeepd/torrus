import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConnectForm from './ConnectForm'

describe('ConnectForm', () => {
  it('toggles password visibility without changing the password', () => {
    const onConnect = vi.fn()
    render(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    const password = screen.getByTestId('password-input')

    fireEvent.change(password, { target: { value: 'mistyped-password' } })
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('mistyped-password')

    const showPassword = screen.getByRole('button', { name: 'Show password' })
    expect(showPassword).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(showPassword)

    expect(password).toHaveAttribute('type', 'text')
    expect(password).toHaveValue('mistyped-password')
    expect(password).toHaveFocus()

    const hidePassword = screen.getByRole('button', { name: 'Hide password' })
    expect(hidePassword).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(hidePassword)

    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('mistyped-password')
    expect(password).toHaveFocus()
  })
})
