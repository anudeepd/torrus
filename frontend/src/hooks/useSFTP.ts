import { useCallback, useEffect, useMemo } from 'react'
import type { Socket } from 'socket.io-client'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import type { SFTPEntry } from '@/types'

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
  results?: Array<{ ok?: boolean; code?: string; message?: string }>
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

function joinPath(base: string, name: string): string {
  if (name.startsWith('/')) return name
  if (!base || base === '.') return name
  return `${base.replace(/\/$/, '')}/${name}`
}

function parentPath(path: string): string {
  if (!path || path === '.' || path === '/') return '.'
  const clean = path.replace(/\/$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx <= 0) return '.'
  return clean.slice(0, idx)
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
  const sessionId = useTerminalStore(s => s.sessionId)
  const setTabStatus = useTerminalStore(s => s.setTabStatus)
  const tab = useSFTPStore(s => s.tabs[tabId])
  const transfers = useSFTPStore(s => s.transfers.filter(t => t.tabId === tabId))
  const ensureTab = useSFTPStore(s => s.ensureTab)
  const setListing = useSFTPStore(s => s.setListing)
  const setUsername = useSFTPStore(s => s.setUsername)
  const setIsRoot = useSFTPStore(s => s.setIsRoot)
  const setLoading = useSFTPStore(s => s.setLoading)
  const setError = useSFTPStore(s => s.setError)
  const setDisconnected = useSFTPStore(s => s.setDisconnected)
  const clearSelected = useSFTPStore(s => s.clearSelected)
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
    socket.emit('sftp:open', {
      session_id: sessionId,
      tab_id: tabId,
      source_tab_id: sourceTabId ?? tabId,
    })
  }, [socket, sessionId, tabId, sourceTabId, ensureTab, setLoading])

  useEffect(() => {
    open()
  }, [open])

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
        setError(tabId, failed?.message ?? payload.message ?? 'Delete failed. Check permissions and retry.')
        clearSelected(tabId)
        if (connectionClosed) {
          setDisconnected(tabId, true)
          setTabStatus(tabId, 'dead')
        } else if (payload.results?.some(result => result.ok === true)) {
          refreshCurrentDirectory()
        }
        return
      }
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
    socket.on('sftp:open:result', onListing)
    socket.on('sftp:list:result', onListing)
    socket.on('sftp:error', onError)
    socket.on('sftp:upload:result', onMutation)
    socket.on('sftp:delete:result', onDelete)
    socket.on('sftp:rename:result', onMutation)
    socket.on('sftp:mkdir:result', onMutation)
    socket.on('sftp:chmod:result', onChmod)
    socket.on('sftp:download:result', onDownload)
    return () => {
      socket.off('sftp:open:result', onListing)
      socket.off('sftp:list:result', onListing)
      socket.off('sftp:error', onError)
      socket.off('sftp:upload:result', onMutation)
      socket.off('sftp:delete:result', onDelete)
      socket.off('sftp:rename:result', onMutation)
      socket.off('sftp:mkdir:result', onMutation)
      socket.off('sftp:chmod:result', onChmod)
      socket.off('sftp:download:result', onDownload)
    }
  }, [socket, tabId, refreshCurrentDirectory, setTabStatus, setError, setListing, setUsername, setIsRoot, setDisconnected, clearSelected])

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

  const clearError = useCallback(() => setError(tabId, null), [setError, tabId])

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
    clearError,
    parentPath,
  }
}
