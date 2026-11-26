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

  it('focuses each invalid field and never submits invalid values', () => {
    const onConnect = vi.fn()
    render(
      <ConnectForm
        initialHost="example.com"
        initialPort={22}
        initialUsername="alice"
        onConnect={onConnect}
      />,
    )
    const host = screen.getByTestId('host-input')
    const username = screen.getByTestId('username-input')
    const port = screen.getByTestId('port-input')

    fireEvent.change(host, { target: { value: ' ' } })
    fireEvent.submit(host.closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Host is required.')
    expect(host).toHaveFocus()

    fireEvent.change(host, { target: { value: 'example.com' } })
    fireEvent.change(username, { target: { value: ' ' } })
    fireEvent.submit(username.closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Username is required.')
    expect(username).toHaveFocus()

    fireEvent.change(username, { target: { value: 'alice' } })
    fireEvent.change(port, { target: { value: '70000' } })
    fireEvent.submit(port.closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Port must be 1-65535.')
    expect(port).toHaveFocus()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('only submits Enter from an input, not from another form control or key', () => {
    const onConnect = vi.fn()
    render(<ConnectForm onConnect={onConnect} />)
    const host = screen.getByTestId('host-input')
    const button = screen.getByRole('button', { name: 'Show password' })

    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(host, { key: 'x' })
    expect(onConnect).not.toHaveBeenCalled()
  })
})
