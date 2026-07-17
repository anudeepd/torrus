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
})
