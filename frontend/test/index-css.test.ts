import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/index.css', 'utf8')

describe('terminal scrollbar CSS', () => {
  it('keeps the xterm scrollbar track aligned with the terminal background', () => {
    expect(css).toContain('.xterm-viewport {\n  background-color: #020617;')
    expect(css).toContain('overflow-y: auto !important;')
    expect(css).toContain('scrollbar-width: thin;')
    expect(css).toContain('.xterm-viewport::-webkit-scrollbar {\n  width: 8px;')
    expect(css).toContain('scrollbar-color: #64748b #0f172a;')
    expect(css).toContain('.xterm-viewport::-webkit-scrollbar-track {\n  background: #0f172a;')
  })

  it('prevents pane scrolling from moving the document viewport', () => {
    expect(css).toContain('html,\n  body,\n  #root {\n    height: 100%;\n    overflow: hidden;\n    overscroll-behavior: none;')
  })

  it('keeps browser-native scrollbars in the dark theme', () => {
    expect(css).toContain('color-scheme: dark;')
  })
})

describe('password input CSS', () => {
  it('hides browser-native reveal and credential controls beside the app toggle', () => {
    expect(css).toContain('.torrus-password-input::-ms-reveal,')
    expect(css).toContain('.torrus-password-input::-ms-clear {')
    expect(css).toContain('.torrus-password-input::-moz-reveal {')
    expect(css).toContain('.torrus-password-input::-webkit-credentials-auto-fill-button {')
    expect(css).toContain('.torrus-password-input::-webkit-textfield-decoration-container {')
    expect(css).toContain('  display: none;')
  })
})
