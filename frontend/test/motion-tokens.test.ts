import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { motionDuration, motionEase } from '../src/motion/tokens'

describe('motion system', () => {
  const css = readFileSync('src/index.css', 'utf8')

  it('keeps CSS and TypeScript timing tokens aligned', () => {
    expect(css).toContain(`--motion-duration-instant: ${motionDuration.instant * 1000}ms`)
    expect(css).toContain(`--motion-duration-micro: ${motionDuration.micro * 1000}ms`)
    expect(css).toContain(`--motion-duration-surface: ${motionDuration.surface * 1000}ms`)
    expect(css).toContain(`--motion-duration-spatial: ${motionDuration.spatial * 1000}ms`)
    expect(css).toContain(`--motion-ease-move: cubic-bezier(${motionEase.move.join(', ')})`)
    expect(css).toContain(`--motion-ease-exit: cubic-bezier(${motionEase.exit.join(', ')})`)
  })

  it('globally removes spatial and repeated motion for reduced-motion users', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('animation-iteration-count: 1 !important')
    expect(css).toContain('.motion-press:active:not(:disabled) { transform: none; }')
  })
})
