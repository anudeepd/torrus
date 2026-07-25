import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConnectForm from './ConnectForm'

describe('ConnectForm', () => {
  it('uses the native password control', () => {
    const onConnect = vi.fn()
    render(<ConnectForm error="Authentication failed" onConnect={onConnect} />)
    const password = screen.getByTestId('password-input')

    fireEvent.change(password, { target: { value: 'mistyped-password' } })

    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('mistyped-password')
    expect(screen.queryByRole('button', { name: /password/i })).not.toBeInTheDocument()
  })
})
