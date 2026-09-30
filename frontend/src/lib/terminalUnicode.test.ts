import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { enableUnicode11 } from './terminalUnicode'

/** Column the cursor reaches after `text` is written to an empty terminal. */
async function cursorColumnAfter(text: string): Promise<number> {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 })
  enableUnicode11(term)
  await new Promise<void>(resolve => term.write(text, resolve))
  const column = term.buffer.active.cursorX
  term.dispose()
  return column
}

// Readline and tmux advance their own cursor model by libc's wcwidth; the
// terminal must move by the same number of cells or their redraws land in the
// wrong place.
describe('enableUnicode11', () => {
  it.each([
    ['ASCII', 'abc', 3],
    ['emoji', '😀🚀', 4],
    ['symbols libc treats as wide', '✅❌⚡⭐', 8],
    ['CJK', '漢字', 4],
    ['a combining mark', 'e\u0301', 1],
  ])('advances the cursor correctly for %s', async (_label, text, expected) => {
    expect(await cursorColumnAfter(text)).toBe(expected)
  })
})
