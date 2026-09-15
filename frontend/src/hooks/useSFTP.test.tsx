import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { useSFTP } from './useSFTP'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'

/**
 * Engine-compatible XMLHttpRequest stand-in: `send` reports progress and then
 * the server's committed ranges, so the upload finishes inside `act`.
 */
interface UploadScriptEntry {
  ranges?: number[][]
  received?: number
  status?: number
  code?: string
  message?: string
}

class MockUploadRequest {
  static script: UploadScriptEntry[] = []
  status = 200
  responseText = ''
  url = ''
  upload = {
    listeners: new Map<string, Array<(event: { loaded: number }) => void>>(),
    addEventListener(type: string, handler: (event: { loaded: number }) => void) {
      const handlers = this.listeners.get(type) ?? []
      handlers.push(handler)
      this.listeners.set(type, handlers)
    },
    emit(type: string, event: { loaded: number }) {
      for (const handler of this.listeners.get(type) ?? []) handler(event)
    },
  }
  private listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, handler: () => void) {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener() {}

  open(_method: string, url: string) {
    this.url = url
  }

  abort() {
    queueMicrotask(() => this.emit('abort'))
  }

  send(body: Blob) {
    const step = MockUploadRequest.script.shift() ?? {}
    this.upload.emit('loadstart', { loaded: 0 })
    this.upload.emit('progress', { loaded: body.size })
    this.upload.emit('load', { loaded: body.size })
    this.status = step.status ?? 200
    this.responseText = JSON.stringify(
      step.status
        ? { code: step.code ?? 'TRANSFER_FAILED', message: step.message ?? 'SFTP write failed' }
        : { ranges: step.ranges ?? [], received: step.received ?? 0 },
    )
    this.emit('load')
  }

  private emit(type: string) {
    for (const handler of this.listeners.get(type) ?? []) handler()
  }
}

function createMockUploadRequest(script: UploadScriptEntry[]) {
  MockUploadRequest.script = script
  return MockUploadRequest
}

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
      error: 'Could not load folder: SSH connection lost. Reconnect to continue.',
    })
    expect(useTerminalStore.getState().tabs[0].status).toBe('dead')
  })

  it('stops loading when a generic SFTP error reports a closed connection', () => {
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => result.current.list('/root'))
    expect(useSFTPStore.getState().tabs[tabId]?.loading).toBe(true)

    act(() => {
      socket._trigger('sftp:error', {
        tab_id: tabId,
        code: 'CONNECTION_CLOSED',
        message: 'SSH connection lost. Reconnect to continue.',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({
      disconnected: true,
      loading: false,
      error: 'SSH connection lost. Reconnect to continue.',
    })
  })

  it('marks the tab dead when a mutation result reports a closed connection', () => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:rename:result', {
        tab_id: tabId,
        ok: false,
        code: 'CONNECTION_CLOSED',
        message: 'SSH connection lost. Reconnect to continue.',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({
      disconnected: true,
      error: 'Could not rename item: SSH connection lost. Reconnect to continue.',
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

  it('allows a new listing immediately after the source SSH session closes', () => {
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
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    act(() => {
      result.current.list('/root')
      socket._trigger('ssh:closed', { tab_id: 'terminal-tab', reason: 'Connection closed.' })
      result.current.list('/root')
    })

    expect(socket.emit.mock.calls.filter(call => call[0] === 'sftp:list')).toHaveLength(2)
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

  it('stops loading when a directory listing result never arrives', () => {
    vi.useFakeTimers()
    const socket = createMockSocket()
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => result.current.list('/root'))
    expect(useSFTPStore.getState().tabs[tabId]?.loading).toBe(true)

    act(() => vi.advanceTimersByTime(15_000))
    expect(useSFTPStore.getState().tabs[tabId]).toMatchObject({
      loading: false,
      error: 'Folder listing timed out. Refresh to try again.',
    })
  })

  it('uploads through the resumable protocol and reports byte progress', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(input).includes('/init')
          ? { upload_id: 'abc', chunk_size: 5, concurrency: 1, size: 5 }
          : { path: 'release.txt', size: 5 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('XMLHttpRequest', createMockUploadRequest([{ ranges: [[0, 5]], received: 5 }]))
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))
    socket.emit.mockClear()

    await act(async () => {
      await result.current.uploadFiles([new File(['hello'], 'release.txt')])
    })

    // init and complete go through fetch; the body goes through the engine's XHR.
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      '/_upload/init?session_id=test-session&tab_id=sftp-tab',
      '/_upload/abc/complete?session_id=test-session&tab_id=sftp-tab',
    ])
    expect(useSFTPStore.getState().transfers[0]).toMatchObject({
      status: 'done',
      bytes: 5,
      progress: 100,
    })
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '.' }))
  })

  it('creates the folders a dropped tree needs before uploading into them', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>>(async input => ({
      ok: true,
      status: 200,
      json: async () =>
        String(input).includes('/init')
          ? { upload_id: 'abc', chunk_size: 5, concurrency: 1, size: 5 }
          : { path: 'note.txt', size: 5 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'XMLHttpRequest',
      createMockUploadRequest([
        { ranges: [[0, 5]], received: 5 },
        { ranges: [[0, 5]], received: 5 },
      ]),
    )
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    const upload = result.current.uploadFiles([
      { file: new File(['hello'], 'note.txt'), relativePath: 'trip/photos/note.txt' },
      { file: new File(['world'], 'deep.txt'), relativePath: 'trip/deep.txt' },
    ])

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        'sftp:mkdirs',
        expect.objectContaining({ paths: ['trip', 'trip/photos'], tab_id: tabId }),
      ),
    )
    // Nothing is uploaded until the folders exist.
    expect(fetchMock).not.toHaveBeenCalled()

    const mkdirs = socket.emit.mock.calls.find(call => call[0] === 'sftp:mkdirs')![1] as {
      request_id: string
    }
    await act(async () => {
      socket._trigger('sftp:mkdirs:result', {
        tab_id: tabId,
        request_id: mkdirs.request_id,
        ok: true,
        created: ['trip', 'trip/photos'],
      })
      await upload
    })

    // Each file uploads into its own folder on the remote host.
    const bodies = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('/init'))
      .map(call => JSON.parse(String((call[1] as RequestInit).body)))
      .sort((a, b) => a.dir.localeCompare(b.dir))
    expect(bodies).toEqual([
      { filename: 'deep.txt', size: 5, dir: 'trip' },
      { filename: 'note.txt', size: 5, dir: 'trip/photos' },
    ])
    expect(useSFTPStore.getState().transfers.map(item => item.name).sort()).toEqual([
      'trip/deep.txt',
      'trip/photos/note.txt',
    ])
    expect(useSFTPStore.getState().transfers.every(item => item.status === 'done')).toBe(true)
  })

  it('surfaces a folder that could not be created instead of uploading into it', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    const upload = result.current.uploadFiles([
      { file: new File(['hello'], 'note.txt'), relativePath: 'locked/note.txt' },
    ])
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('sftp:mkdirs', expect.anything()))
    const mkdirs = socket.emit.mock.calls.find(call => call[0] === 'sftp:mkdirs')![1] as {
      request_id: string
    }

    await act(async () => {
      socket._trigger('sftp:mkdirs:result', {
        tab_id: tabId,
        request_id: mkdirs.request_id,
        ok: false,
        code: 'PERMISSION_DENIED',
        message: 'Permission denied: /locked',
      })
      await upload
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useSFTPStore.getState().tabs[tabId]?.error).toBe('Permission denied: /locked')
  })

  it('resumes a failed window from the bytes the server confirmed', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(input).includes('/init')
          ? { upload_id: 'abc', chunk_size: 4, concurrency: 1, size: 8 }
          : { path: 'resume.txt', size: 8 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const requests: MockUploadRequest[] = []
    vi.stubGlobal(
      'XMLHttpRequest',
      class extends MockUploadRequest {
        constructor() {
          super()
          requests.push(this)
        }
      },
    )
    createMockUploadRequest([
      { ranges: [[0, 4]], received: 4 },
      { status: 502, code: 'TRANSFER_FAILED', message: 'SFTP write failed' },
      { ranges: [[0, 8]], received: 4 },
    ])
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    await act(async () => {
      await result.current.uploadFiles([new File(['abcdefgh'], 'resume.txt')])
    })

    expect(useSFTPStore.getState().transfers[0]).toMatchObject({
      status: 'done',
      bytes: 8,
      progress: 100,
    })
    // The retry re-sent the failed window only: never back to offset 0.
    expect(requests.map(request => new URL(request.url, 'http://x').searchParams.get('offset')))
      .toEqual(['0', '4', '4'])
  })

  it('starts large downloads through the browser without buffering the file', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    await act(async () => {
      await result.current.download({
        name: 'archive.tar',
        path: '/srv/app/archive.tar',
        type: 'file',
        size: 6 * 1024 * 1024,
        mtime: 1,
      })
    })

    expect(anchorClick).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    anchorClick.mockRestore()
  })

  it('downloads multiple files through the bulk zip endpoint', async () => {
    const socket = createMockSocket()
    const blob = new Blob(['zip-bytes'], { type: 'application/zip' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => blob,
      headers: new Headers({ 'Content-Disposition': "attachment; filename*=UTF-8''logs.zip" }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    await act(async () => {
      await result.current.bulkDownload([
        { name: 'a.log', path: '/var/log/a.log', type: 'file', size: 1, mtime: 1 },
        { name: 'b.log', path: '/var/log/b.log', type: 'file', size: 1, mtime: 1 },
      ])
    })

    expect(fetchMock).toHaveBeenCalledWith('/sftp/bulk-download', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'test-session',
        tab_id: tabId,
        paths: ['/var/log/a.log', '/var/log/b.log'],
      }),
    }))
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(anchorClick).toHaveBeenCalledOnce()
    // Revocation is deferred so the browser can start the download first.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    const revokeCall = setTimeoutSpy.mock.calls.find(call => call[1] === 1000)
    expect(revokeCall).toBeDefined()
    ;(revokeCall![0] as () => void)()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    anchorClick.mockRestore()
    setTimeoutSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('surfaces bulk download failures through the store error', async () => {
    const socket = createMockSocket()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Failed to create archive' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    await act(async () => {
      await result.current.bulkDownload([
        { name: 'a.log', path: '/var/log/a.log', type: 'file', size: 1, mtime: 1 },
      ])
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Failed to create archive')
    vi.unstubAllGlobals()
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


  it.each([
    ['upload', 'Upload failed'],
    ['download', 'Download failed'],
    ['rename', 'Could not rename item'],
    ['mkdir', 'Could not create folder'],
  ] as const)('labels %s failures with operation context', (operation, prefix) => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger('sftp:error', {
        tab_id: tabId,
        operation,
        code: 'PERMISSION_DENIED',
        message: 'Permission denied: /srv/app/locked',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe(
      `${prefix}: Permission denied: /srv/app/locked`,
    )
  })

  it.each([
    ['sftp:chmod:result', 'Could not update permissions'],
    ['sftp:chown:result', 'Could not update ownership'],
    ['sftp:list:result', 'Could not load folder'],
    ['sftp:accounts:result', 'Could not load remote accounts'],
  ] as const)('labels %s failures with operation context', (event, prefix) => {
    const socket = createMockSocket()
    renderHook(() => useSFTP(tabId, 'terminal-tab', socket as unknown as Socket))

    act(() => {
      socket._trigger(event, {
        tab_id: tabId,
        ok: false,
        code: 'PERMISSION_DENIED',
        message: 'Permission denied: /srv/app/locked',
      })
    })

    expect(useSFTPStore.getState().tabs[tabId].error).toBe(
      `${prefix}: Permission denied: /srv/app/locked`,
    )
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

    expect(useSFTPStore.getState().tabs[tabId].error).toBe('Deleted 1 item. Failed to delete locked: Permission denied: /root/locked')
    expect(useSFTPStore.getState().tabs[tabId].notice).toEqual({
      tone: 'error',
      message: 'Deleted 1 item. Failed to delete locked: Permission denied: /root/locked',
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
