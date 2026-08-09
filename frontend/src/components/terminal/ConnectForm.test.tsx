import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConnectForm from './ConnectForm'

describe('ConnectForm', () => {
  it('toggles password visibility without changing the password', () => {
    const onConnect = vi.fn()
    render(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    const password = screen.getByTestId('password-input')
    expect(password).toHaveClass('torrus-password-input')

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

  it('submits from Enter in both masked and visible password modes', () => {
    const onConnect = vi.fn()
    render(<ConnectForm onConnect={onConnect} />)

    fireEvent.change(screen.getByTestId('host-input'), { target: { value: 'example.com' } })
    fireEvent.change(screen.getByTestId('username-input'), { target: { value: 'alice' } })
    const password = screen.getByTestId('password-input')
    fireEvent.change(password, { target: { value: 'secret' } })

    fireEvent.keyDown(password, { key: 'Enter' })
    expect(onConnect).toHaveBeenCalledWith({
      host: 'example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
    })

    onConnect.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    fireEvent.keyDown(password, { key: 'Enter' })
    expect(onConnect).toHaveBeenCalledWith({
      host: 'example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
    })
  })
})
