import { afterEach, describe, expect, it, vi } from 'vitest'

describe('useServerConfigStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.doUnmock('@/utils/authRedirect')
    vi.resetModules()
  })

  it('redirects to LDAPGate when config loading gets a 401', async () => {
    const redirectToLdapLogin = vi.fn()
    vi.doMock('@/utils/authRedirect', () => ({ redirectToLdapLogin }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    ))

    const { useServerConfigStore } = await import('./serverConfigStore')
    await useServerConfigStore.getState().load()

    expect(redirectToLdapLogin).toHaveBeenCalledOnce()
  })

  it('stores the LDAP enabled flag from config responses', async () => {
    const redirectToLdapLogin = vi.fn()
    vi.doMock('@/utils/authRedirect', () => ({ redirectToLdapLogin }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ ldap_enabled: true })
    ))

    const { useServerConfigStore } = await import('./serverConfigStore')
    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState().ldapEnabled).toBe(true)
    expect(redirectToLdapLogin).not.toHaveBeenCalled()
  })
})
