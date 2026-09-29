/**
 * True when the browser draws its own reveal button inside `<input type="password">`.
 *
 * Firefox does when `layout.forms.reveal-password-button.enabled` is on (Nightly,
 * some forks, any profile that sets it), next to the app's own toggle. Page CSS
 * cannot remove it: `::-moz-reveal` is user-agent-only, `::-ms-reveal` is Edge's,
 * and painting it invisible is undone by Firefox's
 * `input:autofill { color: FieldText !important }`, which is the normal state of a
 * login form. What it does do is reserve room at the end of the field, so the
 * password input reports a smaller `clientWidth` than an identical text input.
 * When it does, the browser's control is the only one the app shows.
 *
 * Measure with the field's current classes and before the caller changes its
 * padding for the answer: the probe is a text input styled exactly like the field.
 */
export function browserDrawsRevealButton(field: HTMLInputElement): boolean {
  const parent = field.parentElement
  if (!parent) return false
  const probe = document.createElement('input')
  probe.type = 'text'
  probe.tabIndex = -1
  probe.autocomplete = 'off'
  probe.className = field.className
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  parent.appendChild(probe)
  const reserved = probe.clientWidth - field.clientWidth
  probe.remove()
  return reserved > 2
}
