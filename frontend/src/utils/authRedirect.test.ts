import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ldapLoginUrl,
  submitLdapLogout,
  resetAuthRedirectForTests,
} from './authRedirect'

beforeEach(() => {
  resetAuthRedirectForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ldapLoginUrl', () => {
  it('preserves the current app path as the LDAP redirect target', () => {
    expect(ldapLoginUrl({
      pathname: '/terminals',
      search: '?layout=split',
      hash: '#pane-2',
    })).toBe('/_auth/login?redirect=%2Fterminals%3Flayout%3Dsplit%23pane-2')
  })

  it('falls back to the app root when pathname is empty', () => {
    expect(ldapLoginUrl({
      pathname: '',
      search: '',
      hash: '',
    })).toBe('/_auth/login?redirect=%2F')
  })
})

describe('redirectToLdapLogin', () => {
  it('dispatches auth-redirect event and sets timeout for redirect', async () => {
    const authRedirect = await import('./authRedirect')

    const eventSpy = vi.spyOn(window, 'dispatchEvent')
    authRedirect.redirectToLdapLogin()

    expect(eventSpy).toHaveBeenCalledOnce()
    expect(eventSpy).toHaveBeenCalledWith(expect.any(Event))
    expect(eventSpy.mock.calls[0][0].type).toBe('torrus:auth-redirect')
  })

  it('does nothing if redirect is already in progress', async () => {
    const authRedirect = await import('./authRedirect')
    const eventSpy = vi.spyOn(window, 'dispatchEvent')

    authRedirect.redirectToLdapLogin()
    eventSpy.mockClear()
    authRedirect.redirectToLdapLogin()

    expect(eventSpy).not.toHaveBeenCalled()
  })
})

describe('submitLdapLogout', () => {
  it('dispatches auth-logout event and submits form after delay', () => {
    const eventSpy = vi.spyOn(window, 'dispatchEvent')
    const form = { submit: vi.fn() } as unknown as HTMLFormElement

    submitLdapLogout(form)

    expect(eventSpy).toHaveBeenCalledOnce()
    expect(eventSpy).toHaveBeenCalledWith(expect.any(Event))
    expect(eventSpy.mock.calls[0][0].type).toBe('torrus:auth-logout')

    vi.advanceTimersByTime(1500)
    expect(form.submit).toHaveBeenCalledOnce()
  })
})

describe('redirectToLdapLoginNow', () => {
  it('calls window.location.assign with the login URL', async () => {
    const authRedirect = await import('./authRedirect')
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign, pathname: '/terminals', search: '', hash: '' },
      writable: true,
    })

    authRedirect.redirectToLdapLoginNow()

    expect(assign).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith('/_auth/login?redirect=%2Fterminals')
  })
})
