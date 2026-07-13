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

  it('marks the tab dead when a mutation result reports a closed connection', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:upload:result', {
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

  it('stores username and root status from the open response', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/root',
        entries: [],
        username: 'root',
        is_root: true,
      })
    })

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({
      path: '/root',
      username: 'root',
      isRoot: true,
    })
  })

  it('shows delete errors without reloading the directory', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    act(() => useSFTPStore.getState().setSelected(tabId, ['/root/file']))
    socket.emit.mockClear()

    act(() => {
      socket._trigger('sftp:delete:result', {
        tab_id: tabId,
        ok: false,
        results: [{ ok: false, code: 'PERMISSION_DENIED', message: 'Permission denied: /root/file' }],
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Permission denied: /root/file')
    expect(useSFTPStore.getState().tabs[tabId].selectedPaths).toEqual([])
    expect(socket.emit).not.toHaveBeenCalledWith('sftp:list', expect.anything())
  })

  it('reloads the directory after a partially successful delete', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => {
      socket._trigger('sftp:delete:result', {
        tab_id: tabId,
        ok: false,
        results: [
          { ok: true },
          { ok: false, code: 'PERMISSION_DENIED', message: 'Permission denied: /root/locked' },
        ],
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Permission denied: /root/locked')
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '.' }))
  })

  it('emits chmod with the numeric permission mode', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => result.current.chmod('/tmp/file', 0o640))

    expect(socket.emit).toHaveBeenCalledWith('sftp:chmod', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/tmp/file',
      mode: 0o640,
    })

    act(() => {
      socket._trigger('sftp:list:result', {
        tab_id: tabId,
        ok: true,
        path: '/home/deploy',
        entries: [],
      })
    })

    socket.emit.mockClear()
    act(() => {
      socket._trigger('sftp:chmod:result', {
        tab_id: tabId,
        ok: true,
        path: '/tmp/file',
        mode: 0o640,
      })
    })
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '/home/deploy' }))
  })
})
