/**
 * Scrollbar styling differs by engine in a way CSS cannot detect.
 *
 * Chromium and Safari style scrollbars through `::-webkit-scrollbar`; Firefox
 * ignores those rules and needs the standard `scrollbar-width`/`scrollbar-color`
 * instead. An `@supports selector(::-webkit-scrollbar)` test cannot tell them
 * apart: **Waterfox answers true** while rendering nothing from those rules.
 * Measured on Waterfox 6.7.4 (rv:153.0) against this app's own stylesheet —
 * `CSS.supports('selector(::-webkit-scrollbar)')` true, `scrollbar-width`
 * computed `auto`, every scroll region drawn with the default 14px bar, while
 * `.xterm-viewport` (which does set the standard properties) stayed thin and
 * dark. Handing the standard properties to Chromium instead is not an option
 * either: Blink prefers them over the custom rules (measured on the sibling
 * app: the bar went 8px -> 17px, and here `.xterm-viewport` renders 12px next
 * to the app's 8px custom bars for the same reason).
 *
 * So the engine is asked to prove it: a throwaway scroll container is styled
 * with `::-webkit-scrollbar { width: 4px }`, and only when its gutter does not
 * become 4px does the document get marked for the standard-property rules in
 * `index.css` (`html[data-scrollbars='standard']`).
 */

/** Width, in CSS px, the probe asks a `::-webkit-scrollbar` rule to be. */
const PROBE_WIDTH = 4

/** Attribute the probe sets on `<html>` for engines that ignore the custom rules. */
export const STANDARD_SCROLLBARS_ATTRIBUTE = 'data-scrollbars'

/** True when the engine really laid the probe scrollbar out at `PROBE_WIDTH`. */
export function engineStylesWebkitScrollbars(gutterWidth: number): boolean {
  // A browser that ignores the rule reports its own default (14px on the systems
  // seen so far) and one drawing overlay scrollbars reports 0; both belong to the
  // standard-property branch. The tolerance absorbs a track border.
  return gutterWidth > 0 && gutterWidth <= PROBE_WIDTH + 1
}

/**
 * Mark the document when the engine ignores `::-webkit-scrollbar`, so the rules
 * in `index.css` can give it the same thin dark bar. Runs once, before the app
 * renders, because it has to be decided before the first scroll region is
 * painted.
 */
export function installScrollbarFallback(doc: Document = document): void {
  const style = doc.createElement('style')
  style.textContent = `[data-scrollbar-probe]::-webkit-scrollbar { width: ${PROBE_WIDTH}px; height: ${PROBE_WIDTH}px; }`
  const probe = doc.createElement('div')
  probe.setAttribute('data-scrollbar-probe', '')
  probe.style.cssText = 'position:fixed;top:-100px;left:-100px;width:100px;height:100px;overflow:scroll'
  doc.head.appendChild(style)
  doc.documentElement.appendChild(probe)

  const gutterWidth = probe.offsetWidth - probe.clientWidth

  probe.remove()
  style.remove()
  if (engineStylesWebkitScrollbars(gutterWidth)) return

  doc.documentElement.setAttribute(STANDARD_SCROLLBARS_ATTRIBUTE, 'standard')
}
