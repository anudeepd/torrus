import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/index.css', 'utf8')

describe('terminal scrollbar CSS', () => {
  it('keeps the xterm scrollbar track aligned with the terminal background', () => {
    expect(css).toContain('.xterm-viewport {\n  background-color: #020617;')
    expect(css).toContain('scrollbar-color: #334155 #020617;')
    expect(css).toContain('.xterm-viewport::-webkit-scrollbar-track {\n  background: #020617;')
  })

  it('prevents pane scrolling from moving the document viewport', () => {
    expect(css).toContain('html,\n  body,\n  #root {\n    height: 100%;\n    overflow: hidden;\n    overscroll-behavior: none;')
  })
})
