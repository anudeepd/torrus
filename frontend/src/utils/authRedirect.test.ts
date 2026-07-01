import { describe, expect, it } from 'vitest'
import { ldapLoginUrl } from './authRedirect'

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
