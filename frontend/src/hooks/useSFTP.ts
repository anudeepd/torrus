import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import type { SFTPEntry, SFTPGroup, SFTPUser } from '@/types'

const LARGE_UPLOAD_THRESHOLD = 25 * 1024 * 1024

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

function itemLabel(path?: string): string {
  if (!path) return 'item'
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      resolve(value.includes(',') ? value.split(',')[1] : value)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
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
  const sessionId = useTerminalStore(s => s.sessionId)
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
    ensureTab(tabId)
    setLoading(tabId, true)
    socket.emit('sftp:list', { session_id: sessionId, tab_id: tabId, path: targetPath })
  }, [socket, sessionId, tabId, ensureTab, setLoading])

  const refreshCurrentDirectory = useCallback(() => {
    list(useSFTPStore.getState().tabs[tabId]?.path ?? '.')
  }, [list, tabId])

  const open = useCallback(() => {
    ensureTab(tabId)
    setLoading(tabId, true)
    setDisconnected(tabId, false)
    socket.emit('sftp:open', {
      session_id: sessionId,
      tab_id: tabId,
      source_tab_id: sourceTabId ?? tabId,
    })
  }, [socket, sessionId, tabId, sourceTabId, ensureTab, setDisconnected, setLoading])

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
    if (!sourceTabId) {
      openOnce()
      return
    }
    const onSourceReady = (payload: { tab_id?: string; status?: string }) => {
      if (payload.tab_id !== sourceTabId) return
      if (payload.status !== undefined && payload.status !== 'active') return
      openOnce()
    }
    const timeout = sourceStatus === 'connected' ? window.setTimeout(openOnce, 250) : undefined
    socket.on('session:restored', onSourceReady)
    socket.on('ssh:connected', onSourceReady)
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      socket.off('session:restored', onSourceReady)
      socket.off('ssh:connected', onSourceReady)
    }
  }, [open, socket, sourceStatus, sourceTabId])

  useEffect(() => {
    const onListing = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        setError(tabId, payload.message ?? payload.code ?? 'Unable to list directory.')
        if (payload.code === 'CONNECTION_CLOSED') {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        }
        return
      }
      if (payload.username !== undefined) setUsername(tabId, payload.username)
      if (payload.is_root !== undefined) setIsRoot(tabId, payload.is_root)
      setListing(tabId, payload.path ?? '.', payload.entries ?? [])
      setTabStatus(tabId, 'connected')
    }
    const onError = (payload: SFTPErrorPayload) => {
      if (payload.tab_id !== tabId) return
      setError(tabId, payload.message ?? 'Transfer failed. Check connection and retry.')
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
  }, [socket, tabId, refreshCurrentDirectory, setTabStatus, setError, setNotice, setListing, setUsername, setIsRoot, setDisconnected])

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const currentPath = useSFTPStore.getState().tabs[tabId]?.path ?? '.'
    for (const file of Array.from(files)) {
      const remotePath = joinPath(currentPath, file.name)
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
      try {
        if (file.size > LARGE_UPLOAD_THRESHOLD) {
          const response = await fetch(
            `/sftp/upload?session_id=${encodeURIComponent(sessionId)}&tab_id=${encodeURIComponent(tabId)}&path=${encodeURIComponent(remotePath)}`,
            { method: 'POST', body: file },
          )
          if (!response.ok) throw new Error(`Upload failed (${response.status})`)
        } else {
          socket.emit('sftp:upload', {
            session_id: sessionId,
            tab_id: tabId,
            path: remotePath,
            data: await fileToBase64(file),
          })
        }
        updateTransfer(transferId, { status: 'done', progress: 100, bytes: file.size })
      } catch (error) {
        updateTransfer(transferId, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed',
        })
      }
    }
    list(currentPath)
  }, [socket, sessionId, tabId, list, addTransfer, updateTransfer])

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
