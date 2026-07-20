import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { uploadChunkSize, useSFTP } from './useSFTP'
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

  it('uses larger upload chunks for very large files without exceeding 32 MB', () => {
    expect(uploadChunkSize(0)).toBe(8 * 1024 * 1024)
    expect(uploadChunkSize(1024 * 1024 * 1024)).toBe(8 * 1024 * 1024)
    expect(uploadChunkSize(5 * 1024 * 1024 * 1024)).toBe(32 * 1024 * 1024)
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

  it('marks the tab dead when its source SSH session closes', () => {
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
          status: 'connected',
          sessionKey: 'test-session:terminal-tab',
        },
        {
          id: tabId,
          type: 'sftp',
          host: 'server.example',
          port: 22,
          username: 'deploy',
          label: 'SFTP deploy@server.example',
          status: 'connected',
          sessionKey: 'test-session:sftp-tab',
          sourceTabId: 'terminal-tab',
        },
      ],
    })
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => socket._trigger('ssh:closed', { tab_id: 'terminal-tab', reason: 'Connection closed.' }))

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({ disconnected: true })
    expect(useTerminalStore.getState().tabs.find(tab => tab.id === tabId)?.status).toBe('dead')
  })

  it('shows reconnect immediately when a persisted source SSH tab is disconnected', () => {
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
          status: 'disconnected',
          sessionKey: 'test-session:terminal-tab',
        },
        {
          id: tabId,
          type: 'sftp',
          host: 'server.example',
          port: 22,
          username: 'deploy',
          label: 'SFTP deploy@server.example',
          status: 'connected',
          sessionKey: 'test-session:sftp-tab',
          sourceTabId: 'terminal-tab',
        },
      ],
    })

    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({ disconnected: true })
    expect(useTerminalStore.getState().tabs.find(tab => tab.id === tabId)?.status).toBe('dead')
    expect(socket.emit).not.toHaveBeenCalledWith('sftp:open', expect.anything())

    act(() => result.current.open())

    expect(useTerminalStore.getState().activeTabId).toBe('terminal-tab')
    expect(socket.emit).not.toHaveBeenCalledWith('sftp:open', expect.anything())
  })

  it('creates and activates a replacement SSH tab when source tab is closed', () => {
    const socket = createMockSocket()
    useTerminalStore.setState({
      sessionId: 'test-session',
      activeTabId: tabId,
      tabs: [{
        id: tabId,
        type: 'sftp',
        host: 'server.example',
        port: 2222,
        username: 'deploy',
        label: 'SFTP deploy@server.example',
        status: 'dead',
        sessionKey: 'test-session:sftp-tab',
        sourceTabId: 'closed-terminal-tab',
      }],
    })
    const { result } = renderHook(() => useSFTP(tabId, 'closed-terminal-tab', socket as unknown as Socket))

    act(() => result.current.open())

    const state = useTerminalStore.getState()
    const replacement = state.tabs.find(tab => tab.type === 'terminal')
    expect(replacement).toMatchObject({ host: 'server.example', port: 2222, username: 'deploy', status: 'disconnected' })
    expect(state.tabs.find(tab => tab.id === tabId)?.sourceTabId).toBe(replacement?.id)
    expect(state.activeTabId).toBe(replacement?.id)
    expect(socket.emit).toHaveBeenCalledWith('session:register', {
      session_id: 'test-session',
      tab_id: replacement?.id,
    })
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

  it('ignores stale directory responses after navigating to a newer path', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      result.current.list('/older')
      result.current.list('/newer')
      socket._trigger('sftp:list:result', { tab_id: tabId, ok: true, path: '/older', entries: [{ name: 'stale', path: '/older/stale', type: 'file', size: 1, mode: 0, mtime: 0 }] })
    })
    expect(useSFTPStore.getState().tabs[tabId]?.path).not.toBe('/older')

    act(() => socket._trigger('sftp:list:result', { tab_id: tabId, ok: true, path: '/newer', entries: [] }))
    expect(useSFTPStore.getState().tabs[tabId]?.path).toBe('/newer')
  })

  it('accepts server-normalized paths that differ only by trailing slash or dots', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => result.current.list('/foo/bar/'))
    expect(useSFTPStore.getState().tabs[tabId]?.loading).toBe(true)

    act(() => socket._trigger('sftp:list:result', { tab_id: tabId, ok: true, path: '/foo/bar', entries: [{ name: 'file.txt', path: '/foo/bar/file.txt', type: 'file', size: 1, mode: 0, mtime: 0 }] }))
    expect(useSFTPStore.getState().tabs[tabId]?.path).toBe('/foo/bar')
    expect(useSFTPStore.getState().tabs[tabId]?.loading).toBe(false)
  })

  it('coalesces concurrent refreshes of the same path into one queued request', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => {
      result.current.list('/root')
      result.current.list('/root')
      result.current.list('/root')
    })
    expect(socket.emit.mock.calls.filter(call => call[0] === 'sftp:list')).toHaveLength(1)

    act(() => socket._trigger('sftp:list:result', { tab_id: tabId, ok: true, path: '/root', entries: [] }))
    expect(socket.emit.mock.calls.filter(call => call[0] === 'sftp:list')).toHaveLength(2)
  })

  it('uploads through the resumable chunk endpoint and reports byte progress', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ offset: 5 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    class MockUploadRequest {
      status = 200
      responseText = '{"offset":5}'
      upload: { onprogress?: (event: { loaded: number }) => void } = {}
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      open() {}
      send() {
        this.upload.onprogress?.({ loaded: 5 })
        this.onload?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', MockUploadRequest)
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    await act(async () => {
      await result.current.uploadFiles([new File(['hello'], 'release.txt')])
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sftp/upload/init?')
    expect(useSFTPStore.getState().transfers[0]).toMatchObject({
      status: 'done',
      bytes: 5,
      progress: 100,
    })
    expect(socket.emit).not.toHaveBeenCalledWith('sftp:upload', expect.anything())
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

  it('shows SFTP error events as visible failure notices', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:error', {
        tab_id: tabId,
        code: 'PERMISSION_DENIED',
        message: 'Permission denied: /srv/app/locked.txt',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].notice).toEqual({
      tone: 'error',
      message: 'Permission denied: /srv/app/locked.txt',
    })
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
