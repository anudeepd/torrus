type AuthRedirectLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

export const AUTH_REDIRECT_EVENT = 'torrus:auth-redirect'

let redirectInProgress = false

export function ldapLoginUrl(location: AuthRedirectLocation = window.location): string {
  const redirectPath = `${location.pathname || '/'}${location.search}${location.hash}`
  return `/_auth/login?redirect=${encodeURIComponent(redirectPath)}`
}

export function redirectToLdapLogin(): void {
  if (redirectInProgress) return
  redirectInProgress = true
  window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT))
  window.location.assign(ldapLoginUrl())
}
