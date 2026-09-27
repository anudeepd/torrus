import { describe, expect, it } from 'vitest'
import { cn } from './cn'

/**
 * The class-merge contract the primitives rely on: a consumer's class has to
 * beat the base class it collides with, or every `Dialog` that sets its own
 * width renders at full width again (that regression shipped in 0.2.51).
 */
describe('cn', () => {
  it('lets the last class of a group win', () => {
    expect(cn('w-full', 'w-80')).toBe('w-80')
    expect(cn('p-5', 'p-0')).toBe('p-0')
    expect(cn('w-full', 'max-w-xl')).toBe('w-full max-w-xl')
  })

  it('knows the project z-index scale', () => {
    expect(cn('z-dialog', 'z-overlay')).toBe('z-overlay')
  })

  it('keeps conditional and array inputs working', () => {
    expect(cn('flex', ['gap-2', { hidden: false, truncate: true }], undefined)).toBe('flex gap-2 truncate')
  })
})
