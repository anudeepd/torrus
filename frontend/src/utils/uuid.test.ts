import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuid } from './uuid'

describe('uuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7)
        return bytes
      },
    })

    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('still returns an id without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined)

    expect(uuid()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
  })
})
