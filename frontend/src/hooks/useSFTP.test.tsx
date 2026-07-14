import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { useSFTP } from './useSFTP'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'

describe('useSFTP', () => {
  const tabId = 'sftp-tab'

  beforeEach(() => {
    vi.useRealTimers()
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

  afterEach(() => {
    vi.useRealTimers()
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

  it('shows detailed delete errors without reloading the directory', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    act(() => useSFTPStore.getState().setSelected(tabId, ['/root/file']))
    socket.emit.mockClear()

    act(() => {
      socket._trigger('sftp:delete:result', {
        tab_id: tabId,
        ok: false,
        results: [{ ok: false, path: '/root/file', code: 'PERMISSION_DENIED', message: 'Permission denied: /root/file' }],
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Failed to delete file: Permission denied: /root/file')
    expect(useSFTPStore.getState().tabs[tabId].notice).toEqual({
      tone: 'error',
      message: 'Failed to delete file: Permission denied: /root/file',
    })
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
          { ok: false, path: '/root/locked', code: 'PERMISSION_DENIED', message: 'Permission denied: /root/locked' },
        ],
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Deleted 1 item; failed to delete locked: Permission denied: /root/locked')
    expect(useSFTPStore.getState().tabs[tabId].notice).toEqual({
      tone: 'error',
      message: 'Deleted 1 item; failed to delete locked: Permission denied: /root/locked',
    })
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '.' }))
  })

  it('posts a success notice after delete succeeds', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => {
      socket._trigger('sftp:delete:result', {
        tab_id: tabId,
        ok: true,
        results: [
          { ok: true, path: '/tmp/one' },
          { ok: true, path: '/tmp/two' },
        ],
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].notice).toEqual({
      tone: 'success',
      message: 'Deleted 2 items.',
    })
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

  it('emits chown with numeric owner and group ids', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => result.current.chown('/tmp/file', 1000, 1001))

    expect(socket.emit).toHaveBeenCalledWith('sftp:chown', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/tmp/file',
      uid: 1000,
      gid: 1001,
    })
  })

  it('loads remote account choices', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => result.current.loadAccounts())
    expect(socket.emit).toHaveBeenCalledWith('sftp:accounts', {
      session_id: 'test-session',
      tab_id: tabId,
    })

    act(() => {
      socket._trigger('sftp:accounts:result', {
        tab_id: tabId,
        ok: true,
        users: [{ uid: 1000, name: 'app' }],
        groups: [{ gid: 1000, name: 'app' }],
      })
    })

    expect(result.current.users).toEqual([{ uid: 1000, name: 'app' }])
    expect(result.current.groups).toEqual([{ gid: 1000, name: 'app' }])
  })

  it('waits for restored source terminal before opening persisted sftp tabs', () => {
    vi.useFakeTimers()
    const socket = createMockSocket()
    useTerminalStore.setState({
      sessionId: 'test-session',
      activeTabId: tabId,
      tabs: [
        {
          id: 'terminal-tab',
          type: 'terminal',
          host: 'server.example',
          port: 22,
          username: 'deploy',
          label: 'deploy@server.example',
          status: 'connecting',
          sessionKey: 'test-session:terminal-tab',
        },
        {
          id: tabId,
          type: 'sftp',
          host: 'server.example',
          port: 22,
          username: 'deploy',
          label: 'SFTP deploy@server.example',
          status: 'connecting',
          sessionKey: `test-session:${tabId}`,
          sourceTabId: 'terminal-tab',
        },
      ],
    })

    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    expect(socket.emit).not.toHaveBeenCalledWith('sftp:open', expect.anything())

    act(() => {
      socket._trigger('session:restored', { tab_id: 'terminal-tab', status: 'active' })
    })

    expect(socket.emit).toHaveBeenCalledWith('sftp:open', {
      session_id: 'test-session',
      tab_id: tabId,
      source_tab_id: 'terminal-tab',
    })
  })
})
