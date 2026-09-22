/**
 * The one source of truth for the layout breakpoints the JavaScript reads.
 *
 * The same four values live in `tailwind.config.js` under `theme.extend.screens`
 * (`xs` 600, `md2` 720, `nav` 800, `wide` 900) so CSS and JS switch at the same
 * width. `test/design-tokens.test.ts` asserts the two files agree — change both.
 */
export const BREAKPOINTS = {
  xs: 600,
  md2: 720,
  nav: 800,
  wide: 900,
} as const

export const below = (width: number) => `(max-width: ${width}px)`
export const above = (width: number) => `(min-width: ${width}px)`
