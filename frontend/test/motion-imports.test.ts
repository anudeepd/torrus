import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sourceFiles } from './sourceFiles'

const css = readFileSync('src/index.css', 'utf8')

describe('motion import discipline', () => {
  it('uses lightweight components with strict LazyMotion', () => {
    // `motion` components are not allowed under LazyMotion strict: the bundle
    // would either fail at runtime or silently pull in the full feature set.
    const offenders = sourceFiles('src').filter(file =>
      /import\s+\{[^}]*\bmotion\b[^}]*\}\s+from ['"]motion\/react['"]/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('<LazyMotion features={domAnimation} strict>')
  })

  it('keeps press feedback animating every property the controls change', () => {
    // A `transition` shorthand here overrides a `transition-colors` utility on
    // the same element, so the rule has to carry the colour properties too or
    // Button loses its hover fade (regression in 0.2.51).
    const rule = css.match(/\.motion-press\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('transition:')
    for (const property of ['transform', 'color', 'background-color']) {
      expect(rule).toContain(property)
    }
  })
})
