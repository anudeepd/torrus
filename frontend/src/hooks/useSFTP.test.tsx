import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Socket } from 'socket.io-client'
import { useSFTP } from './useSFTP'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'

describe('useSFTP', () => {
  const tabId = 'sftp-tab'

  beforeEach(() => {
    useSFTPStore.setState({ tabs: {}, transfers: [] })
    useTerminalStore.setState({
      sessionId: 'test-session',
      activeTabId: tabId,
      tabs: [{
        id: tabId,
        type: 'sftp',
        host: 'server.example',
        port: 22,
        username: 'deploy',
        label: 'SFTP deploy@server.example',
        status: 'connected',
        sessionKey: `test-session:${tabId}`,
      }],
    })
  })

  it('marks the tab dead when a directory listing reports a closed connection', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:list:result', {
        tab_id: tabId,
        ok: false,
        code: 'CONNECTION_CLOSED',
        message: 'SSH connection lost. Reconnect to continue.',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({
      disconnected: true,
      error: 'SSH connection lost. Reconnect to continue.',
    })
    expect(useTerminalStore.getState().tabs[0].status).toBe('dead')
  })
})
