import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import type { SFTPEntry, SFTPGroup, SFTPUser } from '@/types'
import { SpeedTracker, UploadClient, UploadState, uploadFile } from '@/lib/upload-engine'
import { uuid } from '@/utils/uuid'

// Keep inline Socket.IO downloads below server memory/message limits. Larger
// files automatically use streaming HTTP; users do not need to choose a path.
const LARGE_UPLOAD_THRESHOLD = 5 * 1024 * 1024
/** Files uploaded at the same time; each file's chunks are pipelined inside the engine. */
const MAX_CONCURRENT_UPLOADS = 2
const LISTING_TIMEOUT_MS = 15_000

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
  code?: string
  message?: string
}

type SFTPErrorOperation = 'upload' | 'download' | 'rename' | 'mkdir'

interface SFTPErrorPayload {
  tab_id: string
  code?: string
  message?: string
  operation?: SFTPErrorOperation
}

interface AccountsPayload {
  tab_id: string
  ok?: boolean
  users?: SFTPUser[]
  groups?: SFTPGroup[]
  code?: string
  message?: string
}

/** A file plus the folder path it was dropped under. */
export interface UploadCandidate {
  file: File
  relativePath: string
}

interface MkdirsResult {
  ok?: boolean
  message?: string
}

/** How long a folder-upload request may wait for its directories to exist. */
const MKDIRS_TIMEOUT_MS = 15_000

interface PendingUpload {
  file: File
  remotePath: string
  /** Server-confirmed session, reused so a retry resumes from committed bytes. */
  session: {
    uploadId: string
    chunkSize: number
    concurrency: number
    ranges: number[][]
    size: number
  } | null
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
    return `Deleted ${plural(succeeded.length, 'item')}. Failed to delete ${plural(failed.length, 'item')}${target}: ${detail}`
  }
  if (failed.length > 1) {
    return `Failed to delete ${plural(failed.length, 'item')}${target}: ${detail}`
  }
  if (succeeded.length > 0) {
    return `Deleted ${plural(succeeded.length, 'item')}. Failed to delete ${itemLabel(firstFailure?.path)}: ${detail}`
  }
  return `Failed to delete ${itemLabel(firstFailure?.path)}: ${detail}`
}

const OPERATION_FAILURE_PREFIX: Record<SFTPErrorOperation, string> = {
  upload: 'Upload failed',
  download: 'Download failed',
  rename: 'Could not rename item',
  mkdir: 'Could not create folder',
}

function contextualFailureMessage(
  prefix: string,
  payload: { message?: string },
  fallback: string,
): string {
  const detail = payload.message ?? fallback
  return detail.toLowerCase().startsWith(prefix.toLowerCase())
    ? detail
    : `${prefix}: ${detail}`
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

function triggerBlobDownload(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke after the browser has had a chance to start the download; revoking
  // synchronously can abort the transfer before it begins.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function useSFTP(tabId: string, sourceTabId: string | undefined, socket: Socket) {
  const [users, setUsers] = useState<SFTPUser[]>([])
  const [groups, setGroups] = useState<SFTPGroup[]>([])
  const openedRef = useRef(false)
  const pendingUploadsRef = useRef(new Map<string, PendingUpload>())
  const pendingMkdirsRef = useRef(new Map<string, (result: MkdirsResult) => void>())
  const pendingListingPathRef = useRef<string | null>(null)
  const queuedSamePathRefreshRef = useRef(false)
  const listingTimeoutRef = useRef<number | null>(null)
  const quietListingRef = useRef(false)
  // Read once: the tab remembers where the user was before the reload.
  const restorePathRef = useRef<string | null>(
    useTerminalStore.getState().tabs.find(current => current.id === tabId)?.sftpPath ?? null,
  )
  const sessionId = useTerminalStore(s => s.sessionId)
  const addTab = useTerminalStore(s => s.addTab)
  const setActiveTab = useTerminalStore(s => s.setActiveTab)
  const setSourceTab = useTerminalStore(s => s.setSourceTab)
  const setTabConnection = useTerminalStore(s => s.setTabConnection)
  const setTabStatus = useTerminalStore(s => s.setTabStatus)
  const setTabSftpPath = useTerminalStore(s => s.setTabSftpPath)
  const sourceStatus = useTerminalStore(s => sourceTabId ? s.tabs.find(tab => tab.id === sourceTabId)?.status : 'connected')
  const tab = useSFTPStore(s => s.tabs[tabId])
  const transfers = useSFTPStore(s => s.transfers.filter(t => t.tabId === tabId))
  const ensureTab = useSFTPStore(s => s.ensureTab)
  const setListing = useSFTPStore(s => s.setListing)
  const setListingQuiet = useSFTPStore(s => s.setListingQuiet)
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
  const clearListingTimeout = useCallback(() => {
    if (listingTimeoutRef.current !== null) {
      window.clearTimeout(listingTimeoutRef.current)
      listingTimeoutRef.current = null
    }
  }, [])

  const scheduleListingTimeout = useCallback((path: string) => {
    clearListingTimeout()
    listingTimeoutRef.current = window.setTimeout(() => {
      listingTimeoutRef.current = null
      if (pendingListingPathRef.current !== path) return
      pendingListingPathRef.current = null
      queuedSamePathRefreshRef.current = false
      // A background refresh never interrupts the view with an error surface.
      if (quietListingRef.current) {
        quietListingRef.current = false
        return
      }
      setError(tabId, 'Folder listing timed out. Refresh to try again.')
    }, LISTING_TIMEOUT_MS)
  }, [clearListingTimeout, setError, tabId])

  useEffect(() => () => clearListingTimeout(), [clearListingTimeout])


  const list = useCallback((path?: string, options?: { quiet?: boolean }) => {
    const targetPath = path ?? useSFTPStore.getState().tabs[tabId]?.path ?? '.'
    const normalized = normalizePath(targetPath)
    if (pendingListingPathRef.current === normalized) {
      queuedSamePathRefreshRef.current = true
      return
    }
    pendingListingPathRef.current = normalized
    quietListingRef.current = options?.quiet === true
    queuedSamePathRefreshRef.current = false
    scheduleListingTimeout(normalized)
    ensureTab(tabId)
    // A background refresh leaves the pane interactive: no loading state.
    if (options?.quiet !== true) setLoading(tabId, true)
    socket.emit('sftp:list', { session_id: sessionId, tab_id: tabId, path: targetPath })
  }, [scheduleListingTimeout, socket, sessionId, tabId, ensureTab, setLoading])

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
      // Reopen the folder this tab was in before the reload; the server falls
      // back to the SFTP home directory when it no longer exists.
      ...(restorePathRef.current ? { path: restorePathRef.current } : {}),
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
      clearListingTimeout()
      pendingListingPathRef.current = null
      queuedSamePathRefreshRef.current = false
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
  }, [clearListingTimeout, open, setDisconnected, setTabStatus, socket, sourceStatus, sourceTabId, tabId])

  useEffect(() => {
    const onListing = (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      const requestedPath = pendingListingPathRef.current
      const responsePath = payload.path === undefined ? undefined : normalizePath(payload.path)
      if (
        requestedPath !== null && responsePath !== undefined && responsePath !== requestedPath
        && requestedPath.startsWith('/') && !requestedPath.startsWith('~/')
      ) return
      clearListingTimeout()
      const quiet = quietListingRef.current
      quietListingRef.current = false
      if (payload.ok === false) {
        pendingListingPathRef.current = null
        // A background refresh stays invisible: keep the listing on screen.
        if (quiet) {
          queuedSamePathRefreshRef.current = false
          return
        }
        showFailure(payload, 'Could not load folder', 'Check the path and retry.')
        if (queuedSamePathRefreshRef.current) {
          queuedSamePathRefreshRef.current = false
          list(requestedPath ?? payload.path ?? '.')
        }
        return
      }
      if (payload.username !== undefined) setUsername(tabId, payload.username)
      if (payload.is_root !== undefined) setIsRoot(tabId, payload.is_root)
      const nextPath = payload.path ?? '.'
      if (quiet) setListingQuiet(tabId, nextPath, payload.entries ?? [])
      else setListing(tabId, nextPath, payload.entries ?? [])
      restorePathRef.current = null
      setTabSftpPath(tabId, nextPath)
      setTabStatus(tabId, 'connected')
      pendingListingPathRef.current = null
      if (queuedSamePathRefreshRef.current) {
        queuedSamePathRefreshRef.current = false
        list(nextPath)
      }
    }
    const showFailure = (
      payload: { code?: string; message?: string },
      prefix?: string,
      fallback = 'SFTP operation failed. Check connection and retry.',
    ) => {
      const message = prefix
        ? contextualFailureMessage(prefix, payload, fallback)
        : payload.message ?? fallback
      setError(tabId, message)
      setNotice(tabId, { tone: 'error', message })
      if (payload.code === 'CONNECTION_CLOSED') {
        setDisconnected(tabId, true)
        setTabStatus(tabId, 'dead')
      }
    }
    const onError = (payload: SFTPErrorPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.operation === undefined) {
        clearListingTimeout()
        pendingListingPathRef.current = null
        queuedSamePathRefreshRef.current = false
      }
      showFailure(
        payload,
        payload.operation ? OPERATION_FAILURE_PREFIX[payload.operation] : undefined,
      )
    }
    const mutationHandler = (prefix: string) => (payload: ListingPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        showFailure(payload, prefix, 'Check permissions and retry.')
        return
      }
      refreshCurrentDirectory()
    }
    const onMkdirs = (payload: { tab_id?: string; request_id?: string; ok?: boolean; message?: string }) => {
      if (payload.tab_id !== tabId || !payload.request_id) return
      const settle = pendingMkdirsRef.current.get(payload.request_id)
      if (!settle) return
      pendingMkdirsRef.current.delete(payload.request_id)
      settle({ ok: payload.ok, message: payload.message })
    }
    const onRename = mutationHandler('Could not rename item')
    const onMkdir = mutationHandler('Could not create folder')
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
    const onChmod = mutationHandler('Could not update permissions')
    const onChown = mutationHandler('Could not update ownership')
    const onDownload = (payload: DownloadPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        showFailure(payload, 'Download failed', 'Check connection and retry.')
        return
      }
      if (payload.data) triggerDownload(payload.name ?? 'download', payload.data)
    }
    const onAccounts = (payload: AccountsPayload) => {
      if (payload.tab_id !== tabId) return
      if (payload.ok === false) {
        showFailure(payload, 'Could not load remote accounts', 'Check permissions and retry.')
        return
      }
      setUsers(payload.users ?? [])
      setGroups(payload.groups ?? [])
    }
    socket.on('sftp:open:result', onListing)
    socket.on('sftp:list:result', onListing)
    socket.on('sftp:error', onError)
    socket.on('sftp:delete:result', onDelete)
    socket.on('sftp:rename:result', onRename)
    socket.on('sftp:mkdir:result', onMkdir)
    socket.on('sftp:mkdirs:result', onMkdirs)
    socket.on('sftp:chmod:result', onChmod)
    socket.on('sftp:chown:result', onChown)
    socket.on('sftp:download:result', onDownload)
    socket.on('sftp:accounts:result', onAccounts)
    return () => {
      socket.off('sftp:open:result', onListing)
      socket.off('sftp:list:result', onListing)
      socket.off('sftp:error', onError)
      socket.off('sftp:delete:result', onDelete)
      socket.off('sftp:rename:result', onRename)
      socket.off('sftp:mkdir:result', onMkdir)
      socket.off('sftp:mkdirs:result', onMkdirs)
      socket.off('sftp:chmod:result', onChmod)
      socket.off('sftp:chown:result', onChown)
      socket.off('sftp:download:result', onDownload)
      socket.off('sftp:accounts:result', onAccounts)
    }
  }, [clearListingTimeout, socket, tabId, list, refreshCurrentDirectory, setTabStatus, setError, setNotice, setListing, setListingQuiet, setTabSftpPath, setUsername, setIsRoot, setDisconnected])

  const resumeUpload = useCallback(async (transferId: string, tracker?: SpeedTracker) => {
    const pending = pendingUploadsRef.current.get(transferId)
    if (!pending) return
    const { file, remotePath } = pending
    const speed = tracker ?? new SpeedTracker()
    updateTransfer(transferId, { status: 'active', error: undefined })
    try {
      const client = new UploadClient({
        params: { session_id: sessionId, tab_id: tabId },
      })
      await uploadFile({
        client,
        file,
        destDir: parentPath(remotePath),
        session: pending.session,
        callbacks: {
          onSession: session => {
            pending.session = session
          },
          onProgress: committed => {
            speed.sample(committed)
            updateTransfer(transferId, {
              bytes: committed,
              progress: file.size > 0 ? Math.round((committed / file.size) * 100) : 0,
              speed: speed.speed(),
            })
          },
          onState: state => {
            if (state === UploadState.PROCESSING) {
              // The server is writing to the remote host (or a DLP scanner is
              // holding the response). Show the wait instead of looking stuck.
              updateTransfer(transferId, { speed: speed.speed() })
            }
          },
        },
      })
      pendingUploadsRef.current.delete(transferId)
      updateTransfer(transferId, { status: 'done', progress: 100, bytes: file.size, speed: 0 })
      refreshCurrentDirectory()
    } catch (error) {
      updateTransfer(transferId, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Upload failed',
        speed: 0,
      })
    }
  }, [refreshCurrentDirectory, sessionId, tabId, updateTransfer])

  /**
   * Create the destination folders for a folder upload.
   *
   * One request covers the whole tree: the server checks each path and only
   * creates the missing ones, so re-uploading into an existing folder works.
   */
  const prepareUploadDirectories = useCallback(
    (paths: string[]) => new Promise<MkdirsResult>(resolve => {
      const requestId = uuid().replace(/-/g, '')
      const timer = window.setTimeout(() => {
        pendingMkdirsRef.current.delete(requestId)
        resolve({ ok: false, message: 'Timed out creating the folders for this upload.' })
      }, MKDIRS_TIMEOUT_MS)
      pendingMkdirsRef.current.set(requestId, result => {
        window.clearTimeout(timer)
        resolve(result)
      })
      socket.emit('sftp:mkdirs', {
        session_id: sessionId,
        tab_id: tabId,
        paths,
        request_id: requestId,
      })
    }),
    [socket, sessionId, tabId],
  )

  const uploadFiles = useCallback(async (files: Iterable<File | UploadCandidate>) => {
    const currentPath = useSFTPStore.getState().tabs[tabId]?.path ?? '.'
    // Defensive: enterprise browser extensions (Menlo, ForcePoint) and other
    // content scripts can corrupt a dropped FileList with null or partially-
    // formed entries. Filter them out instead of crashing on `file.name`.
    const candidates: UploadCandidate[] = []
    for (const candidate of files) {
      const file = candidate instanceof File ? candidate : candidate?.file
      if (!file || typeof file.name !== 'string') continue
      const relativePath =
        (candidate instanceof File ? '' : candidate.relativePath) ||
        file.webkitRelativePath ||
        file.name
      candidates.push({ file, relativePath })
    }
    if (candidates.length === 0) return

    const needed = new Set<string>()
    for (const { relativePath } of candidates) {
      const parts = relativePath.split('/').filter(Boolean).slice(0, -1)
      for (let depth = 1; depth <= parts.length; depth += 1) {
        needed.add(joinPath(currentPath, parts.slice(0, depth).join('/')))
      }
    }
    if (needed.size > 0) {
      // Shallowest first: a child cannot be created before its parent.
      const ordered = [...needed].sort(
        (a, b) => a.split('/').length - b.split('/').length
      )
      const prepared = await prepareUploadDirectories(ordered)
      if (prepared.ok === false) {
        setError(tabId, prepared.message ?? 'Could not create the folders for this upload.')
        return
      }
    }

    const pendingIds = candidates.map(({ file, relativePath }) => {
      const transferId = `${tabId}-${relativePath}-${Date.now()}`
      addTransfer({
        id: transferId,
        tabId,
        name: relativePath,
        direction: 'upload',
        status: 'active',
        progress: 0,
        bytes: 0,
        total: file.size,
      })
      pendingUploadsRef.current.set(transferId, {
        file,
        remotePath: joinPath(currentPath, relativePath),
        session: null,
      })
      return transferId
    })
    let next = 0
    // Files run MAX_CONCURRENT_UPLOADS at a time. Chunk concurrency inside one
    // file is the server's call (the 'concurrency' field on init): the SFTP
    // sink serialises writes, but several windows in flight still hide the
    // remote write and the round trip.
    const worker = async () => {
      while (next < pendingIds.length) {
        const transferId = pendingIds[next++]
        await resumeUpload(transferId, new SpeedTracker())
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, pendingIds.length) }, worker))
  }, [tabId, addTransfer, resumeUpload, prepareUploadDirectories, setError])

  const retryUpload = useCallback((transferId: string) => {
    void resumeUpload(transferId, new SpeedTracker())
  }, [resumeUpload])

  const download = useCallback(async (entry: SFTPEntry) => {
    if (entry.size > LARGE_UPLOAD_THRESHOLD) {
      const anchor = document.createElement('a')
      anchor.href = `/sftp/download?session_id=${encodeURIComponent(sessionId)}&tab_id=${encodeURIComponent(tabId)}&path=${encodeURIComponent(entry.path)}`
      anchor.download = entry.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      return
    }
    socket.emit('sftp:download', { session_id: sessionId, tab_id: tabId, path: entry.path })
  }, [socket, sessionId, tabId])

  const bulkDownload = useCallback(async (entries: SFTPEntry[]) => {
    try {
      const response = await fetch('/sftp/bulk-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          tab_id: tabId,
          paths: entries.map(entry => entry.path),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message ?? `Download failed (${response.status})`)
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition')
      const filename = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1]
      triggerBlobDownload(filename ?? 'download.zip', blob)
    } catch (error) {
      setError(tabId, error instanceof Error ? error.message : 'Download failed')
    }
  }, [sessionId, tabId, setError])

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
    bulkDownload,
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
