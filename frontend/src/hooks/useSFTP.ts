import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import type { SFTPEntry, SFTPGroup, SFTPUser } from '@/types'

const LARGE_UPLOAD_THRESHOLD = 25 * 1024 * 1024
const MIN_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024
const TARGET_UPLOAD_CHUNKS = 128
const UPLOAD_RETRY_LIMIT = 3
const MAX_CONCURRENT_UPLOADS = 2

interface ListingPayload {
  tab_id: string
  ok?: boolean
  path?: string
  entries?: SFTPEntry[]
  code?: string
  message?: string
  username?: string | null
  is_root?: boolean
  results?: Array<{ ok?: boolean; path?: string; code?: string; message?: string }>
}

interface DownloadPayload {
  tab_id: string
  ok?: boolean
  name?: string
  data?: string
}

interface SFTPErrorPayload {
  tab_id: string
  code?: string
  message?: string
}

interface AccountsPayload {
  tab_id: string
  ok?: boolean
  users?: SFTPUser[]
  groups?: SFTPGroup[]
  code?: string
  message?: string
}

interface PendingUpload {
  file: File
  remotePath: string
  uploadId: string
  offset: number
}

function joinPath(base: string, name: string): string {
  if (name.startsWith('/')) return name
  if (!base || base === '.') return name
  return `${base.replace(/\/$/, '')}/${name}`
}

function parentPath(path: string): string {
  if (!path || path === '.') return '.'
  if (path === '/') return '/'
  const clean = path.replace(/\/$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx === 0) return '/'
  if (idx < 0) return '.'
  return clean.slice(0, idx)
}

function normalizePath(path: string): string {
  if (!path) return '.'
  if (path === '/') return '/'
  const isAbsolute = path.startsWith('/')
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  const joined = resolved.join('/')
  if (isAbsolute) {
    return joined ? '/' + joined : '/'
  }
  return joined || '.'
}

function itemLabel(path?: string): string {
  if (!path) return 'item'
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function uploadChunkSize(fileSize: number): number {
  if (fileSize <= 0) return MIN_UPLOAD_CHUNK_BYTES
  return Math.min(
    MAX_UPLOAD_CHUNK_BYTES,
    Math.max(MIN_UPLOAD_CHUNK_BYTES, Math.ceil(fileSize / TARGET_UPLOAD_CHUNKS)),
  )
}

function uploadChunkWithProgress(url: string, body: Blob, onProgress: (bytes: number) => void): Promise<{ offset?: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    request.upload.onprogress = event => onProgress(event.loaded)
    request.onload = () => {
      let payload: { offset?: number; message?: string } | null = null
      try { payload = JSON.parse(request.responseText) } catch { /* response handled below */ }
      if (request.status >= 200 && request.status < 300) {
        resolve(payload ?? {})
      } else {
        reject(Object.assign(new Error(payload?.message ?? `Upload failed (${request.status})`), {
          retryable: request.status >= 500 || request.status === 408 || request.status === 429,
        }))
      }
    }
    request.onerror = () => reject(new Error('Upload connection failed'))
    request.send(body)
  })
}

function deleteSuccessMessage(payload: ListingPayload): string {
  const count = payload.results?.filter(result => result.ok !== false).length ?? 0
  return count > 0 ? `Deleted ${plural(count, 'item')}.` : 'Deleted selected items.'
}

function deleteFailureMessage(payload: ListingPayload): string {
  const results = payload.results ?? []
  const failed = results.filter(result => result.ok === false)
  const succeeded = results.filter(result => result.ok === true)
  const firstFailure = failed[0]
  const detail = firstFailure?.message ?? payload.message ?? 'Check permissions and retry.'
  const target = firstFailure?.path ? ` (${itemLabel(firstFailure.path)})` : ''

  if (failed.length > 1 && succeeded.length > 0) {
    return `Deleted ${plural(succeeded.length, 'item')}; failed to delete ${plural(failed.length, 'item')}${target}: ${detail}`
  }
  if (failed.length > 1) {
    return `Failed to delete ${plural(failed.length, 'item')}${target}: ${detail}`
  }
  if (succeeded.length > 0) {
    return `Deleted ${plural(succeeded.length, 'item')}; failed to delete ${itemLabel(firstFailure?.path)}: ${detail}`
  }
  return `Failed to delete ${itemLabel(firstFailure?.path)}: ${detail}`
}

function triggerDownload(name: string, base64Data: string) {
  const binary = atob(base64Data)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function useSFTP(tabId: string, sourceTabId: string | undefined, socket: Socket) {
  const [users, setUsers] = useState<SFTPUser[]>([])
  const [groups, setGroups] = useState<SFTPGroup[]>([])
  const openedRef = useRef(false)
  const pendingUploadsRef = useRef(new Map<string, PendingUpload>())
  const pendingListingPathRef = useRef<string | null>(null)
  const queuedSamePathRefreshRef = useRef(false)
  const sessionId = useTerminalStore(s => s.sessionId)
  const addTab = useTerminalStore(s => s.addTab)
  const setActiveTab = useTerminalStore(s => s.setActiveTab)
  const setSourceTab = useTerminalStore(s => s.setSourceTab)
  const setTabConnection = useTerminalStore(s => s.setTabConnection)
  const setTabStatus = useTerminalStore(s => s.setTabStatus)
  const sourceStatus = useTerminalStore(s => sourceTabId ? s.tabs.find(tab => tab.id === sourceTabId)?.status : 'connected')
  const tab = useSFTPStore(s => s.tabs[tabId])
  const transfers = useSFTPStore(s => s.transfers.filter(t => t.tabId === tabId))
  const ensureTab = useSFTPStore(s => s.ensureTab)
  const setListing = useSFTPStore(s => s.setListing)
  const setUsername = useSFTPStore(s => s.setUsername)
  const setIsRoot = useSFTPStore(s => s.setIsRoot)
  const setLoading = useSFTPStore(s => s.setLoading)
  const setError = useSFTPStore(s => s.setError)
  const setNotice = useSFTPStore(s => s.setNotice)
  const setDisconnected = useSFTPStore(s => s.setDisconnected)
  const addTransfer = useSFTPStore(s => s.addTransfer)
  const updateTransfer = useSFTPStore(s => s.updateTransfer)

  const state = useMemo(() => tab ?? {
    path: '.',
    username: null,
    isRoot: false,
    entries: [],
    selectedPaths: [],
    loading: true,
    error: null,
    notice: null,
    disconnected: false,
  }, [tab])

  const list = useCallback((path?: string) => {
    const targetPath = path ?? useSFTPStore.getState().tabs[tabId]?.path ?? '.'
    const normalized = normalizePath(targetPath)
    if (pendingListingPathRef.current === normalized) {
      queuedSamePathRefreshRef.current = true
      return
    }
    pendingListingPathRef.current = normalized
    queuedSamePathRefreshRef.current = false
    ensureTab(tabId)
    setLoading(tabId, true)
    socket.emit('sftp:list', { session_id: sessionId, tab_id: tabId, path: targetPath })
  }, [socket, sessionId, tabId, ensureTab, setLoading])

  const refreshCurrentDirectory = useCallback(() => {
    list(useSFTPStore.getState().tabs[tabId]?.path ?? '.')
  }, [list, tabId])

  const open = useCallback(() => {
    const currentTabs = useTerminalStore.getState().tabs
    const source = sourceTabId ? currentTabs.find(currentTab => currentTab.id === sourceTabId) : undefined
    if (sourceTabId && !source) {
      const sftpTab = currentTabs.find(currentTab => currentTab.id === tabId)
      const newSourceTabId = addTab()
      if (sftpTab?.host && sftpTab.username) {
        setTabConnection(newSourceTabId, sftpTab.host, sftpTab.port ?? 22, sftpTab.username)
      }
      setSourceTab(tabId, newSourceTabId)
      socket.emit('session:register', { session_id: sessionId, tab_id: newSourceTabId })
      setActiveTab(newSourceTabId)
      return
    }
    const sourceStatus = source?.status ?? 'connected'
    if (sourceTabId && (sourceStatus === 'disconnected' || sourceStatus === 'dead')) {
      setActiveTab(sourceTabId)
      return
    }
    ensureTab(tabId)
    setLoading(tabId, true)
    setDisconnected(tabId, false)
    socket.emit('sftp:open', {
      session_id: sessionId,
      tab_id: tabId,
      source_tab_id: sourceTabId ?? tabId,
    })
  }, [addTab, ensureTab, sessionId, setActiveTab, setDisconnected, setSourceTab, setTabConnection, socket, tabId, sourceTabId, setLoading])

  const loadAccounts = useCallback(() => {
    socket.emit('sftp:accounts', { session_id: sessionId, tab_id: tabId })
  }, [socket, sessionId, tabId])

  useEffect(() => {
    openedRef.current = false
  }, [sourceTabId, tabId])

  useEffect(() => {
    const openOnce = () => {
      if (openedRef.current) return
      openedRef.current = true
      open()
    }
    if (sourceTabId && (sourceStatus === 'disconnected' || sourceStatus === 'dead')) {
      setDisconnected(tabId, true)
      setTabStatus(tabId, 'dead')
    }
    if (!sourceTabId) {
      openOnce()
      return
    }
    const onSourceReady = (payload: { tab_id?: string; status?: string }) => {
      if (payload.tab_id !== sourceTabId) return
      if (payload.status !== undefined && payload.status !== 'active') {
        setDisconnected(tabId, true)
        setTabStatus(tabId, 'dead')
        return
      }
      openOnce()
    }
    const onSourceClosed = (payload: { tab_id?: string }) => {
      if (payload.tab_id !== sourceTabId) return
      setDisconnected(tabId, true)
      setTabStatus(tabId, 'dead')
    }
    const timeout = sourceStatus === 'connected' ? window.setTimeout(openOnce, 250) : undefined
    socket.on('session:restored', onSourceReady)
    socket.on('ssh:connected', onSourceReady)
    socket.on('ssh:closed', onSourceClosed)
    socket.on('ssh:error', onSourceClosed)
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      socket.off('session:restored', onSourceReady)
      socket.off('ssh:connected', onSourceReady)
      socket.off('ssh:closed', onSourceClosed)
      socket.off('ssh:error', onSourceClosed)
    }
  }, [open, setDisconnected, setTabStatus, socket, sourceStatus, sourceTabId, tabId])

  useEffect(() => {
    const onListing = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      const requestedPath = pendingListingPathRef.current
      const responsePath = payload.path === undefined ? undefined : normalizePath(payload.path)
      if (
        requestedPath !== null && responsePath !== undefined && responsePath !== requestedPath
        && requestedPath.startsWith('/') && !requestedPath.startsWith('~/')
      ) return
      if (payload.ok === false) {
        pendingListingPathRef.current = null
        setError(tabId, payload.message ?? payload.code ?? 'Unable to list directory.')
        if (payload.code === 'CONNECTION_CLOSED') {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        }
        if (queuedSamePathRefreshRef.current) {
          queuedSamePathRefreshRef.current = false
          list(requestedPath ?? payload.path ?? '.')
        }
        return
      }
      if (payload.username !== undefined) setUsername(tabId, payload.username)
      if (payload.is_root !== undefined) setIsRoot(tabId, payload.is_root)
      setListing(tabId, payload.path ?? '.', payload.entries ?? [])
      setTabStatus(tabId, 'connected')
      pendingListingPathRef.current = null
      if (queuedSamePathRefreshRef.current) {
        queuedSamePathRefreshRef.current = false
        list(payload.path ?? requestedPath ?? '.')
      }
    }
    const onError = (payload: SFTPErrorPayload) => {
      if (payload.tab_id !== tabId) return
      const message = payload.message ?? 'Transfer failed. Check connection and retry.'
      setError(tabId, message)
      setNotice(tabId, { tone: 'error', message })
      if (payload.code === 'CONNECTION_CLOSED') {
        setDisconnected(tabId, true)
        setTabStatus(tabId, 'dead')
      }
    }
    const onMutation = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        setError(tabId, payload.message ?? 'Operation failed. Check permissions and retry.')
        if (payload.code === 'CONNECTION_CLOSED') {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        }
        return
      }
      refreshCurrentDirectory()
    }
    const onDelete = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        const failed = payload.results?.find(result => result.ok === false)
        const connectionClosed = failed?.code === 'CONNECTION_CLOSED' || payload.code === 'CONNECTION_CLOSED'
        const message = deleteFailureMessage(payload)
        setError(tabId, message)
        setNotice(tabId, { tone: 'error', message })
        if (connectionClosed) {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        } else if (payload.results?.some(result => result.ok === true)) {
          refreshCurrentDirectory()
        }
        return
      }
      setNotice(tabId, { tone: 'success', message: deleteSuccessMessage(payload) })
      refreshCurrentDirectory()
    }
    const onChmod = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        setError(tabId, payload.message ?? 'Unable to update permissions.')
        if (payload.code === 'CONNECTION_CLOSED') {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        }
        return
      }
      refreshCurrentDirectory()
    }
    const onDownload = (payload: DownloadPayload) => {
      if (payload.tab_id !== tabId || !payload.data) return
      triggerDownload(payload.name ?? 'download', payload.data)
    }
    const onAccounts = (payload: AccountsPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        setError(tabId, payload.message ?? 'Unable to load remote accounts.')
        return
      }
      setUsers(payload.users ?? [])
      setGroups(payload.groups ?? [])
    }
    socket.on('sftp:open:result', onListing)
    socket.on('sftp:list:result', onListing)
    socket.on('sftp:error', onError)
    socket.on('sftp:upload:result', onMutation)
    socket.on('sftp:delete:result', onDelete)
    socket.on('sftp:rename:result', onMutation)
    socket.on('sftp:mkdir:result', onMutation)
    socket.on('sftp:chmod:result', onChmod)
    socket.on('sftp:chown:result', onChmod)
    socket.on('sftp:download:result', onDownload)
    socket.on('sftp:accounts:result', onAccounts)
    return () => {
      socket.off('sftp:open:result', onListing)
      socket.off('sftp:list:result', onListing)
      socket.off('sftp:error', onError)
      socket.off('sftp:upload:result', onMutation)
      socket.off('sftp:delete:result', onDelete)
      socket.off('sftp:rename:result', onMutation)
      socket.off('sftp:mkdir:result', onMutation)
      socket.off('sftp:chmod:result', onChmod)
      socket.off('sftp:chown:result', onChmod)
      socket.off('sftp:download:result', onDownload)
      socket.off('sftp:accounts:result', onAccounts)
    }
  }, [socket, tabId, list, refreshCurrentDirectory, setTabStatus, setError, setNotice, setListing, setUsername, setIsRoot, setDisconnected])

  const resumeUpload = useCallback(async (transferId: string) => {
    const pending = pendingUploadsRef.current.get(transferId)
    if (!pending) return
    const { file, remotePath, uploadId } = pending
    const chunkSize = uploadChunkSize(file.size)
    updateTransfer(transferId, { status: 'active', error: undefined })
    try {
      const initResponse = await fetch(
        `/sftp/upload/init?session_id=${encodeURIComponent(sessionId)}&tab_id=${encodeURIComponent(tabId)}&upload_id=${uploadId}`,
        { method: 'POST' },
      )
      if (!initResponse.ok) {
        const body = await initResponse.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message ?? `Upload failed (${initResponse.status})`)
      }
      do {
        const offset = pending.offset
        const end = Math.min(offset + chunkSize, file.size)
        const complete = end === file.size
        let result: { offset?: number } | undefined
        let lastError: unknown
        for (let attempt = 0; attempt < UPLOAD_RETRY_LIMIT; attempt++) {
          try {
            result = await uploadChunkWithProgress(
              `/sftp/upload?session_id=${encodeURIComponent(sessionId)}&tab_id=${encodeURIComponent(tabId)}&path=${encodeURIComponent(remotePath)}&upload_id=${uploadId}&offset=${offset}&total=${file.size}&complete=${complete}`,
              file.slice(offset, end),
              loaded => updateTransfer(transferId, {
                bytes: Math.min(file.size, offset + loaded),
                progress: Math.round((Math.min(file.size, offset + loaded) / file.size) * 100),
              }),
            )
            break
          } catch (error) {
            lastError = error
            if ((error as { retryable?: boolean }).retryable === false) break
            if (attempt + 1 < UPLOAD_RETRY_LIMIT) {
              await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)))
            }
          }
        }
        if (!result) throw lastError instanceof Error ? lastError : new Error('Upload failed')
        const nextOffset = result.offset ?? end
        if ((!complete && nextOffset <= offset) || nextOffset > file.size) throw new Error('Upload did not advance')
        pending.offset = nextOffset
        updateTransfer(transferId, {
          bytes: nextOffset,
          progress: Math.round((nextOffset / file.size) * 100),
        })
      } while (pending.offset < file.size)
      pendingUploadsRef.current.delete(transferId)
      updateTransfer(transferId, { status: 'done', progress: 100, bytes: file.size })
    } catch (error) {
      updateTransfer(transferId, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Upload failed',
      })
    }
  }, [sessionId, tabId, updateTransfer])

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const currentPath = useSFTPStore.getState().tabs[tabId]?.path ?? '.'
    const pendingIds = Array.from(files).map(file => {
      const transferId = `${tabId}-${file.name}-${Date.now()}`
      addTransfer({
        id: transferId,
        tabId,
        name: file.name,
        direction: 'upload',
        status: 'active',
        progress: 0,
        bytes: 0,
        total: file.size,
      })
      pendingUploadsRef.current.set(transferId, {
        file,
        remotePath: joinPath(currentPath, file.name),
        uploadId: globalThis.crypto?.randomUUID?.().replace(/-/g, '')
          ?? `${Date.now()}${Math.random().toString(36).slice(2)}`,
        offset: 0,
      })
      return transferId
    })
    let next = 0
    const worker = async () => {
      while (next < pendingIds.length) {
        const transferId = pendingIds[next++]
        await resumeUpload(transferId)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, pendingIds.length) }, worker))
    list(currentPath)
  }, [tabId, list, addTransfer, resumeUpload])

  const retryUpload = useCallback((transferId: string) => {
    void resumeUpload(transferId)
  }, [resumeUpload])

  const download = useCallback(async (entry: SFTPEntry) => {
    if (entry.size > LARGE_UPLOAD_THRESHOLD) {
      const response = await fetch(
        `/sftp/download?session_id=${encodeURIComponent(sessionId)}&tab_id=${encodeURIComponent(tabId)}&path=${encodeURIComponent(entry.path)}`,
      )
      if (!response.ok) {
        setError(tabId, `Download failed (${response.status})`)
        return
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      return
    }
    socket.emit('sftp:download', { session_id: sessionId, tab_id: tabId, path: entry.path })
  }, [socket, sessionId, tabId, setError])

  const remove = useCallback((paths: string[]) => {
    socket.emit('sftp:delete', { session_id: sessionId, tab_id: tabId, paths })
  }, [socket, sessionId, tabId])

  const rename = useCallback((oldPath: string, newPath: string) => {
    socket.emit('sftp:rename', { session_id: sessionId, tab_id: tabId, old_path: oldPath, new_path: newPath })
  }, [socket, sessionId, tabId])

  const mkdir = useCallback((name: string) => {
    socket.emit('sftp:mkdir', { session_id: sessionId, tab_id: tabId, path: joinPath(state.path, name) })
  }, [socket, sessionId, tabId, state.path])

  const chmod = useCallback((path: string, mode: number) => {
    socket.emit('sftp:chmod', { session_id: sessionId, tab_id: tabId, path, mode })
  }, [socket, sessionId, tabId])

  const chown = useCallback((path: string, uid: number, gid: number) => {
    socket.emit('sftp:chown', { session_id: sessionId, tab_id: tabId, path, uid, gid })
  }, [socket, sessionId, tabId])

  const clearError = useCallback(() => setError(tabId, null), [setError, tabId])
  const clearNotice = useCallback(() => setNotice(tabId, null), [setNotice, tabId])

  return {
    ...state,
    transfers,
    list,
    open,
    uploadFiles,
    retryUpload,
    download,
    remove,
    rename,
    mkdir,
    chmod,
    chown,
    loadAccounts,
    users,
    groups,
    clearError,
    clearNotice,
    parentPath,
  }
}
