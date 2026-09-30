import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal } from '@xterm/xterm'

/**
 * Size terminal cells the way the remote side does.
 *
 * xterm.js measures characters with its Unicode 6 tables, where emoji and
 * symbols such as ✅ ❌ ⚡ ⭐ 🚀 take one cell. The programs on the other end of
 * the PTY (readline, zsh, tmux, through libc's `wcwidth`) give them two. While
 * the two disagree, every cursor move the remote makes lands in the wrong cell:
 * a pasted line containing such characters is drawn with overlapping glyphs,
 * the cursor drifts away from the text, and the next edit redraws the line over
 * itself. The shell's own buffer is intact, so the command still runs.
 *
 * Version 11 is the newest table xterm.js ships and agrees with libc for every
 * character in common use.
 *
 * The terminal must be created with `allowProposedApi: true`; `Terminal.unicode`
 * is not part of xterm.js's stable API.
 */
export function enableUnicode11(term: Terminal): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
}
