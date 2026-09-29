import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Input from './Input'

afterEach(() => {
  Reflect.deleteProperty(HTMLInputElement.prototype, 'clientWidth')
})

describe('Input password reveal', () => {
  it('offers its own toggle when the browser draws none', () => {
    render(<Input label="Password" type="password" />)

    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveClass('pr-10')
  })

  it('never shows two reveal controls when the browser draws its own', () => {
    // jsdom has no layout, so stand in for what Firefox measures when it draws its
    // own reveal button: it reserves room at the end of a password input, which then
    // reports a narrower clientWidth than a text input with the same box.
    Object.defineProperty(HTMLInputElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLInputElement) {
        return this.type === 'password' ? 184 : 200
      },
    })

    render(<Input label="Password" type="password" />)

    expect(screen.queryByRole('button', { name: /password/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Password')).not.toHaveClass('pr-10')
    // The measuring probe is gone again.
    expect(document.querySelectorAll('input')).toHaveLength(1)
  })
})
