import { afterEach, describe, expect, it } from 'vitest'
import { installStyleNonce } from './cspNonce'

const originalCreateElement = document.createElement

afterEach(() => {
  document.createElement = originalCreateElement
  document.head.innerHTML = ''
})

describe('installStyleNonce', () => {
  it('does nothing when the server did not provide a nonce', () => {
    installStyleNonce(document)
    expect(document.createElement).toBe(originalCreateElement)
  })

  it('stamps created style elements with the page nonce', () => {
    const meta = document.createElement('meta')
    meta.name = 'csp-style-nonce'
    meta.content = 'nonce-value'
    document.head.appendChild(meta)

    installStyleNonce(document)

    expect(document.createElement('style').getAttribute('nonce')).toBe('nonce-value')
    expect(document.createElement('div').hasAttribute('nonce')).toBe(false)
  })
})
