import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from './terminalStore'

describe('terminalStore', () => {
  beforeEach(() => {
    useTerminalStore.setState({ sessionId: 'test-session', tabs: [], activeTabId: null })
  })

  it('returns to the source SSH tab when closing its active SFTP tab', () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: 'ssh-source', type: 'terminal', host: 'source.example', port: 22,
          username: 'alice', label: null, status: 'connected', sessionKey: 'test-session:ssh-source',
        },
        {
          id: 'sftp-source', type: 'sftp', host: 'source.example', port: 22,
          username: 'alice', label: 'SFTP alice@source.example', status: 'connected',
          sessionKey: 'test-session:sftp-source', sourceTabId: 'ssh-source',
        },
        {
          id: 'other-ssh', type: 'terminal', host: 'other.example', port: 22,
          username: 'alice', label: null, status: 'connected', sessionKey: 'test-session:other-ssh',
        },
      ],
      activeTabId: 'sftp-source',
    })

    useTerminalStore.getState().closeTab('sftp-source')

    expect(useTerminalStore.getState().activeTabId).toBe('ssh-source')
  })

  it('migrates version-2 persisted tabs', async () => {
    localStorage.setItem(
      'torrus-tabs',
      JSON.stringify({
        state: {
          sessionId: 'legacy',
          tabs: [{ id: 'tab-1', host: 'h', port: 22, username: 'u' }],
          activeTabId: 'tab-1',
        },
        version: 2,
      }),
    )
    await (
      useTerminalStore as typeof useTerminalStore & {
        persist: { rehydrate: () => Promise<void> }
      }
    ).persist.rehydrate()
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      type: 'terminal',
      sessionKey: 'legacy:tab-1',
    })
  })

  it('creates an SFTP tab without a source and returns a missing active tab as null', () => {
    useTerminalStore.setState({
      sessionId: 'test-session',
      tabs: [],
      activeTabId: 'missing',
    })

    const tabId = useTerminalStore.getState().addSftpTab('missing-source')
    const tab = useTerminalStore.getState().tabs.find(item => item.id === tabId)
    expect(tab).toMatchObject({
      type: 'sftp',
      host: null,
      port: null,
      username: null,
      label: 'SFTP',
    })
    useTerminalStore.setState({ activeTabId: 'missing' })
    expect(useTerminalStore.getState().getActiveTab()).toBeNull()
  })

  it('renames tabs and resets blank names to null', () => {
    const tabId = useTerminalStore.getState().addTab()

    useTerminalStore.getState().renameTab(tabId, '  Production  ')
    expect(useTerminalStore.getState().tabs[0]?.label).toBe('Production')

    useTerminalStore.getState().renameTab(tabId, '   ')
    expect(useTerminalStore.getState().tabs[0]?.label).toBeNull()
  })

  it('keeps version-3 persisted tabs unchanged', async () => {
    localStorage.setItem(
      'torrus-tabs',
      JSON.stringify({
        state: {
          sessionId: 'current',
          tabs: [{
            id: 'tab-1',
            type: 'terminal',
            host: 'h',
            port: 22,
            username: 'u',
            label: null,
            status: 'connected',
            sessionKey: 'current:tab-1',
          }],
          activeTabId: 'tab-1',
        },
        version: 3,
      }),
    )
    await (
      useTerminalStore as typeof useTerminalStore & {
        persist: { rehydrate: () => Promise<void> }
      }
    ).persist.rehydrate()
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      type: 'terminal',
      sessionKey: 'current:tab-1',
    })
  })

  it('migrates legacy tabs with missing arrays, ids, and session ids', async () => {
    localStorage.setItem(
      'torrus-tabs',
      JSON.stringify({
        state: {
          tabs: [{}],
          activeTabId: null,
        },
        version: 2,
      }),
    )
    await (
      useTerminalStore as typeof useTerminalStore & {
        persist: { rehydrate: () => Promise<void> }
      }
    ).persist.rehydrate()
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      type: 'terminal',
      sessionKey: ':',
    })

    localStorage.setItem(
      'torrus-tabs',
      JSON.stringify({ state: { sessionId: 'legacy' }, version: 2 }),
    )
    await (
      useTerminalStore as typeof useTerminalStore & {
        persist: { rehydrate: () => Promise<void> }
      }
    ).persist.rehydrate()
    expect(useTerminalStore.getState().tabs).toEqual([])
  })

  it('passes current-version persisted state through migration unchanged', () => {
    const migrate = (
      useTerminalStore as typeof useTerminalStore & {
        persist: { getOptions: () => { migrate?: (state: unknown, version: number) => unknown } }
      }
    ).persist.getOptions().migrate!
    const state = { sessionId: 'current', tabs: [], activeTabId: null }

    expect(migrate(state, 3)).toEqual(state)
  })
})
