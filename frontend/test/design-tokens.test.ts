import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import tailwindConfig from '../tailwind.config.js'
import { BREAKPOINTS } from '../src/lib/breakpoints'
import { motionDuration, motionEase } from '../src/motion/tokens'

const css = readFileSync('src/index.css', 'utf8')
const theme = tailwindConfig.theme.extend

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

describe('design tokens', () => {
  it('defines every surface and brand shade the source references', () => {
    const defined = new Set([
      ...Object.keys(theme.colors.surface).map(shade => `surface-${shade}`),
      ...Object.keys(theme.colors.brand).map(shade => `brand-${shade}`),
    ])
    const referenced = sourceFiles('src').flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/\b(surface|brand)-(\d{2,3})\b/g)]
        .map(match => ({ token: `${match[1]}-${match[2]}`, file })),
    )
    expect(referenced.filter(entry => !defined.has(entry.token))).toEqual([])
  })

  it('keeps the CSS motion variables in step with the TypeScript tokens', () => {
    const declared = new Map(
      [...css.matchAll(/--motion-(duration|ease)-([a-z]+):\s*([^;]+);/g)]
        .map(match => [`${match[1]}-${match[2]}`, match[3].trim()]),
    )
    expect(declared.get('duration-instant')).toBe(`${motionDuration.instant * 1000}ms`)
    expect(declared.get('duration-micro')).toBe(`${motionDuration.micro * 1000}ms`)
    expect(declared.get('duration-surface')).toBe(`${motionDuration.surface * 1000}ms`)
    expect(declared.get('duration-spatial')).toBe(`${motionDuration.spatial * 1000}ms`)
    expect(declared.get('ease-move')).toBe(`cubic-bezier(${motionEase.move.join(', ')})`)
    expect(declared.get('ease-exit')).toBe(`cubic-bezier(${motionEase.exit.join(', ')})`)
  })

  it('keeps the Tailwind screens in step with the JS breakpoints', () => {
    expect(theme.screens).toEqual({
      xs: `${BREAKPOINTS.xs}px`,
      md2: `${BREAKPOINTS.md2}px`,
      nav: `${BREAKPOINTS.nav}px`,
      wide: `${BREAKPOINTS.wide}px`,
    })
  })

  it('leaves no arbitrary type size, breakpoint or z-index at a call site', () => {
    const offenders = sourceFiles('src').flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/\b(?:text|max|min)-\[\d+px\]|\bz-\[\d+\]/g)]
        .map(match => `${file}: ${match[0]}`),
    )
    expect(offenders).toEqual([])
  })

  it('drops motion for reduced-motion users', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toContain('animation-iteration-count: 1 !important')
    expect(css).toContain('.motion-press:active:not(:disabled) { transform: none; }')
  })

  it('hides the Edge password reveal so it cannot double up with the custom toggle', () => {
    expect(css).toContain('.torrus-password-input::-ms-reveal')
  })
})
