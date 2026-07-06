type AuthRedirectLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

export const AUTH_REDIRECT_EVENT = 'torrus:auth-redirect'
export const AUTH_LOGOUT_EVENT = 'torrus:auth-logout'
export const AUTH_REDIRECT_DELAY_MS = 1500

let redirectInProgress = false

export function ldapLoginUrl(location: AuthRedirectLocation = window.location): string {
  const redirectPath = `${location.pathname || '/'}${location.search}${location.hash}`
  return `/_auth/login?redirect=${encodeURIComponent(redirectPath)}`
}

export function redirectToLdapLoginNow(): void {
  window.location.assign(ldapLoginUrl())
}

export function redirectToLdapLogin(): void {
  if (redirectInProgress) return
  redirectInProgress = true
  window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT))
  window.setTimeout(redirectToLdapLoginNow, AUTH_REDIRECT_DELAY_MS)
}

export function submitLdapLogout(form: HTMLFormElement): void {
  window.dispatchEvent(new Event(AUTH_LOGOUT_EVENT))
  window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS)
}

export function resetAuthRedirectForTests(): void {
  redirectInProgress = false
}
