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
      Response.json({ ldap_enabled: true, is_admin: true, ldap_idle_timeout: 900 })
    ))

    const { useServerConfigStore } = await import('./serverConfigStore')
    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState().ldapEnabled).toBe(true)
    expect(useServerConfigStore.getState().isAdmin).toBe(true)
    expect(useServerConfigStore.getState().ldapIdleTimeout).toBe(900)
    expect(redirectToLdapLogin).not.toHaveBeenCalled()
  })

  it('ignores failed or malformed config responses', async () => {
    vi.doMock('@/utils/authRedirect', () => ({ redirectToLdapLogin: vi.fn() }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    )
    let module = await import('./serverConfigStore')
    await module.useServerConfigStore.getState().load()
    expect(module.useServerConfigStore.getState().ldapEnabled).toBe(false)

    vi.resetModules()
    vi.doMock('@/utils/authRedirect', () => ({ redirectToLdapLogin: vi.fn() }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ldap_enabled: true,
          is_admin: false,
          ldap_idle_timeout: 'bad',
        }),
      ),
    )
    module = await import('./serverConfigStore')
    await module.useServerConfigStore.getState().load()
    expect(module.useServerConfigStore.getState().ldapIdleTimeout).toBe(0)

    vi.resetModules()
    vi.doMock('@/utils/authRedirect', () => ({ redirectToLdapLogin: vi.fn() }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    module = await import('./serverConfigStore')
    await module.useServerConfigStore.getState().load()
  })
})
