import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import type { Socket } from 'socket.io-client'
import Button from '@/components/ui/Button'
import FileIcon from './FileIcon'
import TransferQueue from './TransferQueue'
import { useSFTP } from '@/hooks/useSFTP'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useSFTPStore } from '@/store/sftpStore'
import type { SFTPEntry } from '@/types'
import { completedTransferRetentionMs, fade, exitTransition, surfaceTransition } from '@/motion/tokens'
import * as m from 'motion/react-m'
import { AnimatePresence } from 'motion/react'

interface SFTPBrowserProps {
  tabId: string
  sourceTabId?: string
  socket: Socket
}

interface ContextMenuState {
  x: number
  y: number
  entry: SFTPEntry
}

interface ChmodDialogState {
  entry: SFTPEntry
  mode: number
  uid: string
  gid: string
}

type SortKey = 'name' | 'size' | 'owner' | 'mode' | 'mtime'
type SortDirection = 'asc' | 'desc'
type DropWaitState = 'preparing' | 'delayed' | null

interface SortRule {
  key: SortKey
  direction: SortDirection
}

const DRAG_OVERLAY_STALE_MS = 1_500
const DROP_DELAYED_MS = 15_000

function provideContextFeedback() {
  if (window.matchMedia?.('(pointer: coarse)').matches) navigator.vibrate?.(10)
}

function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>, menu: HTMLDivElement | null, onClose: () => void) {
  const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  if (event.key === 'Escape') {
    event.preventDefault()
    onClose()
    return
  }
  if (items.length === 0) return

  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
  let nextIndex: number | null = null
  if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1
  if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = items.length - 1
  if (nextIndex !== null) {
    event.preventDefault()
    items[nextIndex].focus()
  }
}

const PERMISSION_BITS = [
  { label: 'Read', scope: 'Owner', bit: 0o400 },
  { label: 'Write', scope: 'Owner', bit: 0o200 },
  { label: 'Execute', scope: 'Owner', bit: 0o100 },
  { label: 'Read', scope: 'Group', bit: 0o040 },
  { label: 'Write', scope: 'Group', bit: 0o020 },
  { label: 'Execute', scope: 'Group', bit: 0o010 },
  { label: 'Read', scope: 'Other', bit: 0o004 },
  { label: 'Write', scope: 'Other', bit: 0o002 },
  { label: 'Execute', scope: 'Other', bit: 0o001 },
]

const SPECIAL_PERMISSION_BITS = [
  { label: 'Setuid', bit: 0o4000 },
  { label: 'Setgid', bit: 0o2000 },
  { label: 'Sticky', bit: 0o1000 },
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; value >= 1024 && i < units.length; i++) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
}

function formatSize(entry: SFTPEntry): string {
  return entry.type === 'directory' ? '' : formatBytes(entry.size)
}

function formatDate(mtime: number): string {
  if (!mtime) return ''
  return new Date(mtime * 1000).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatMode(mode?: number): string {
  return ((mode ?? 0) & 0o7777).toString(8).padStart(4, '0')
}

function permissionTitle(mode?: number): string {
  const permissionMode = (mode ?? 0) & 0o7777
  return `${formatMode(permissionMode)} ${symbolicMode(permissionMode)}`
}

function formatOwnership(entry: SFTPEntry): string {
  return String(entry.owner ?? entry.uid ?? '-')
}

function formatOwnerGroup(entry: SFTPEntry): string {
  const owner = entry.owner ?? entry.uid ?? '-'
  const group = entry.group ?? entry.gid ?? '-'
  return `${owner}:${group}`
}

function ownershipTitle(entry: SFTPEntry): string {
  return `${formatOwnerGroup(entry)} (uid ${entry.uid ?? '-'}, gid ${entry.gid ?? '-'})`
}

function sortValue(entry: SFTPEntry, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return entry.name.toLowerCase()
    case 'size':
      return entry.type === 'directory' ? -1 : entry.size
    case 'owner':
      return formatOwnership(entry).toLowerCase()
    case 'mode':
      return (entry.mode ?? 0) & 0o7777
    case 'mtime':
      return entry.mtime ?? 0
  }
}

function compareEntries(a: SFTPEntry, b: SFTPEntry, rules: SortRule[]): number {
  for (const rule of rules) {
    const left = sortValue(a, rule.key)
    const right = sortValue(b, rule.key)
    const result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
    if (result !== 0) return rule.direction === 'asc' ? result : -result
  }
  return 0
}

function SortIndicator({ rules, sortKey }: { rules: SortRule[]; sortKey: SortKey }) {
  const index = rules.findIndex(rule => rule.key === sortKey)
  if (index < 0) return null
  const Icon = rules[index].direction === 'asc' ? ChevronUp : ChevronDown
  return (
    <span className="inline-flex items-center gap-0.5 text-brand-400">
      <Icon className="h-3 w-3" />
      {rules.length > 1 && <span className="text-[10px]">{index + 1}</span>}
    </span>
  )
}

function symbolicMode(mode: number): string {
  const chars = ['r', 'w', 'x']
  const symbolic = PERMISSION_BITS.map((permission, index) => mode & permission.bit ? chars[index % 3] : '-')
  if (mode & 0o4000) symbolic[2] = mode & 0o100 ? 's' : 'S'
  if (mode & 0o2000) symbolic[5] = mode & 0o010 ? 's' : 'S'
  if (mode & 0o1000) symbolic[8] = mode & 0o001 ? 't' : 'T'
  return symbolic.join('')
}

function ownershipInputValid(uid: string, gid: string): boolean {
  if (uid.trim() === '' && gid.trim() === '') return true
  const nextUid = Number(uid)
  const nextGid = Number(gid)
  return (
    uid.trim() !== ''
    && gid.trim() !== ''
    && Number.isInteger(nextUid)
    && Number.isInteger(nextGid)
    && nextUid >= 0
    && nextGid >= 0
  )
}

function joinName(path: string, name: string): string {
  if (!path || path === '.') return name
  return `${path.replace(/\/$/, '')}/${name}`
}

function pathSegments(path: string): Array<{ label: string; path: string }> {
  if (!path || path === '.') return [{ label: '~', path: '~' }]
  if (path === '/') return [{ label: '/', path: '/' }]
  const parts = path.split('/').filter(Boolean)
  if (path.startsWith('/')) {
    return [
      { label: '/', path: '/' },
      ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` })),
    ]
  }
  return [
    { label: '~', path: '~' },
    ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') })),
  ]
}

interface PathInputProps {
  inputRef: React.RefObject<HTMLInputElement>
  path: string
  error: string | null
  list: (path: string) => void
  onCancel: () => void
}

function PathInput({ inputRef, path, error, list, onCancel }: PathInputProps) {
  const [value, setValue] = useState(path)
  const submittedRef = useRef(false)

  return (
    <input
      ref={inputRef}
      aria-label="Remote path"
      value={value}
      onChange={event => setValue(event.target.value)}
      onBlur={() => {
        if (!submittedRef.current) onCancel()
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const nextPath = value.trim()
          if (!nextPath || nextPath === path) {
            onCancel()
            return
          }
          submittedRef.current = true
          list(nextPath)
          inputRef.current?.blur()
          onCancel()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      className={clsx(
        'h-7 min-w-0 flex-1 border border-surface-800 bg-surface-900 px-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-500 max-[600px]:h-10',
        { 'border-red-500 text-red-200': error !== null },
      )}
    />
  )
}

interface BreadcrumbsProps {
  path: string
  list: (path: string) => void
  onEdit: () => void
}

function Breadcrumbs({ path, list, onEdit }: BreadcrumbsProps) {
  const [expanded, setExpanded] = useState(false)
  const segments = pathSegments(path)
  const hiddenCount = expanded ? 0 : Math.max(0, segments.length - 4)
  const visible = hiddenCount ? [segments[0], ...segments.slice(-3)] : segments

  return (
    <div
      className="flex h-7 min-w-0 flex-1 items-center overflow-hidden border border-transparent px-1 hover:border-surface-800 hover:bg-surface-900 max-[600px]:h-10"
      onClick={event => {
        if (event.target === event.currentTarget) onEdit()
      }}
    >
      <AnimatePresence initial={false}>
      {visible.map((segment, index) => (
        <m.span initial={{ opacity: 0, maxWidth: 0 }} animate={{ opacity: 1, maxWidth: 160, transition: surfaceTransition }} exit={{ opacity: 0, maxWidth: 0, transition: exitTransition }} key={`${segment.path}-${index}`} className="flex min-w-0 items-center overflow-hidden">
          {index > 0 && !(index === 1 && visible[0]?.path === '/') && <span className="px-1 font-mono text-xs text-slate-600">/</span>}
          {index === 1 && hiddenCount > 0 && (
            <>
              <button
                type="button"
                className="px-1 text-xs text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:h-10"
                onClick={() => setExpanded(true)}
                title={`Show ${hiddenCount} hidden path segments`}
              >
                ...
              </button>
              <span className="px-1 font-mono text-xs text-slate-600">/</span>
            </>
          )}
          {index === 1 && expanded && segments.length > 4 && (
            <button type="button" onClick={() => setExpanded(false)} className="px-1 text-xs text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" title="Collapse path" aria-label="Collapse path">…</button>
          )}
          <button
            type="button"
            onClick={() => list(segment.path)}
            className={clsx('max-w-32 truncate px-1 font-mono text-xs hover:text-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:h-10', {
              'font-medium text-brand-400': index === visible.length - 1,
              'text-slate-600': index !== visible.length - 1,
            })}
            title={segment.path}
          >
            {segment.label}
          </button>
        </m.span>
      ))}
      </AnimatePresence>
      <button
        type="button"
        onClick={onEdit}
        className="ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:h-10 max-[600px]:w-10"
        title="Edit path (Ctrl+L)"
        aria-label="Edit path"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  )
}

function StatusRail({
  tone,
  message,
  onDismiss,
}: {
  tone: 'success' | 'error'
  message: string
  onDismiss: () => void
}) {
  const Icon = tone === 'error' ? CircleAlert : CircleCheck
  const label = tone === 'error' ? 'ERROR' : 'OK'

  return (
    <div
      className={clsx('flex min-h-9 flex-shrink-0 items-start gap-2 border-b border-surface-800 border-l-2 bg-surface-900 px-3 py-2 font-mono text-[11px] leading-4', {
        'border-l-red-400 text-red-200': tone === 'error',
        'border-l-brand-400 text-slate-300': tone === 'success',
      })}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className={clsx('mt-px h-3.5 w-3.5 flex-shrink-0', {
        'text-red-400': tone === 'error',
        'text-brand-400': tone === 'success',
      })} />
      <span className={clsx('flex-shrink-0 font-bold', {
        'text-red-300': tone === 'error',
        'text-brand-400': tone === 'success',
      })}>{label}</span>
      <span className="min-w-0 flex-1 break-words text-slate-300">{message}</span>
      <button type="button" onClick={onDismiss} className="-my-1 flex h-6 w-6 flex-shrink-0 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Dismiss message">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export default function SFTPBrowser({ tabId, sourceTabId, socket }: SFTPBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuTriggerRef = useRef<HTMLElement | null>(null)
  const helpButtonRef = useRef<HTMLButtonElement>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const dragOverlayTimerRef = useRef<number | null>(null)
  const dropDelayTimerRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dropWaitState, setDropWaitState] = useState<DropWaitState>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletePaths, setDeletePaths] = useState<string[] | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [chmodDialog, setChmodDialog] = useState<ChmodDialogState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [sortRules, setSortRules] = useState<SortRule[]>([])
  const {
    path,
    username,
    isRoot,
    entries,
    selectedPaths,
    loading,
    error,
    notice,
    disconnected,
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
  } = useSFTP(tabId, sourceTabId, socket)
  const { toggleSelected, setSelected, clearSelected, removeTransfer } = useSFTPStore()
  const statusNotice = notice ?? (error ? { tone: 'error' as const, message: error } : null)

  const clearDropFeedback = useCallback(() => {
    if (dragOverlayTimerRef.current !== null) {
      window.clearTimeout(dragOverlayTimerRef.current)
      dragOverlayTimerRef.current = null
    }
    if (dropDelayTimerRef.current !== null) {
      window.clearTimeout(dropDelayTimerRef.current)
      dropDelayTimerRef.current = null
    }
    setDragging(false)
    setDropWaitState(null)
  }, [])

  const refreshDragOverlay = useCallback(() => {
    setDragging(true)
    setDropWaitState(null)
    if (dragOverlayTimerRef.current !== null) {
      window.clearTimeout(dragOverlayTimerRef.current)
    }
    if (dropDelayTimerRef.current !== null) {
      window.clearTimeout(dropDelayTimerRef.current)
      dropDelayTimerRef.current = null
    }
    dragOverlayTimerRef.current = window.setTimeout(() => {
      dragOverlayTimerRef.current = null
      setDragging(false)
      setDropWaitState('preparing')
      dropDelayTimerRef.current = window.setTimeout(() => {
        dropDelayTimerRef.current = null
        setDropWaitState('delayed')
      }, DROP_DELAYED_MS)
    }, DRAG_OVERLAY_STALE_MS)
  }, [])

  useEffect(() => {
    const clearWhenHidden = () => {
      if (document.hidden) clearDropFeedback()
    }
    window.addEventListener('drop', clearDropFeedback)
    window.addEventListener('dragend', clearDropFeedback)
    window.addEventListener('blur', clearDropFeedback)
    document.addEventListener('visibilitychange', clearWhenHidden)
    return () => {
      window.removeEventListener('drop', clearDropFeedback)
      window.removeEventListener('dragend', clearDropFeedback)
      window.removeEventListener('blur', clearDropFeedback)
      document.removeEventListener('visibilitychange', clearWhenHidden)
      if (dragOverlayTimerRef.current !== null) {
        window.clearTimeout(dragOverlayTimerRef.current)
        dragOverlayTimerRef.current = null
      }
      if (dropDelayTimerRef.current !== null) {
        window.clearTimeout(dropDelayTimerRef.current)
        dropDelayTimerRef.current = null
      }
    }
  }, [clearDropFeedback])

  const dismissStatusNotice = useCallback(() => {
    clearNotice()
    clearError()
  }, [clearError, clearNotice])

  const closeContextMenu = useCallback((returnFocus = false) => {
    setContextMenu(null)
    if (returnFocus) window.requestAnimationFrame(() => contextMenuTriggerRef.current?.focus())
  }, [])
  const closeHelpMenu = useCallback((returnFocus = false) => {
    setHelpOpen(false)
    if (returnFocus) window.requestAnimationFrame(() => helpButtonRef.current?.focus())
  }, [])
  const closeMoreMenu = useCallback((returnFocus = false) => {
    setMoreActionsOpen(false)
    if (returnFocus) window.requestAnimationFrame(() => moreButtonRef.current?.focus())
  }, [])
  const closeNewFolder = useCallback(() => setNewFolderOpen(false), [])
  const closePermissions = useCallback(() => setChmodDialog(null), [])
  const closeDelete = useCallback(() => setDeletePaths(null), [])

  const newFolderDialogRef = useModalFocus(newFolderOpen, closeNewFolder, folderInputRef)
  const chmodDialogRef = useModalFocus(Boolean(chmodDialog), closePermissions)
  const deleteDialogRef = useModalFocus(Boolean(deletePaths), closeDelete, deleteCancelRef)
  const completedTransferTimersRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (!editingPath) return
    pathInputRef.current?.focus()
    pathInputRef.current?.select()
  }, [editingPath])

  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [contextMenu])

  useEffect(() => {
    if (!moreActionsOpen) return
    moreMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [moreActionsOpen])

  useEffect(() => {
    if (!error) return
    const timeout = window.setTimeout(clearError, 12000)
    return () => window.clearTimeout(timeout)
  }, [clearError, error])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(clearNotice, notice.tone === 'error' ? 12000 : 5000)
    return () => window.clearTimeout(timeout)
  }, [clearNotice, notice])

  useEffect(() => {
    const completedIds = new Set(transfers.filter(transfer => transfer.status === 'done').map(transfer => transfer.id))
    completedIds.forEach(id => {
      if (completedTransferTimersRef.current.has(id)) return
      const timer = window.setTimeout(() => {
        completedTransferTimersRef.current.delete(id)
        removeTransfer(id)
      }, completedTransferRetentionMs)
      completedTransferTimersRef.current.set(id, timer)
    })
    completedTransferTimersRef.current.forEach((timer, id) => {
      if (completedIds.has(id)) return
      window.clearTimeout(timer)
      completedTransferTimersRef.current.delete(id)
    })
  }, [removeTransfer, transfers])

  useEffect(() => () => {
    completedTransferTimersRef.current.forEach(timer => window.clearTimeout(timer))
    completedTransferTimersRef.current.clear()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setEditingPath(true)
      } else if (event.key === 'Escape') {
        if (contextMenu) {
          event.preventDefault()
          closeContextMenu(true)
        } else if (helpOpen) {
          event.preventDefault()
          closeHelpMenu(true)
        } else if (moreActionsOpen) {
          event.preventDefault()
          closeMoreMenu(true)
        }
      }
    }
    const closeMenu = () => {
      setContextMenu(null)
      setHelpOpen(false)
      setMoreActionsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', closeMenu)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', closeMenu)
    }
  }, [closeContextMenu, closeHelpMenu, closeMoreMenu, contextMenu, helpOpen, moreActionsOpen])

  const sortedEntries = useMemo(
    () => sortRules.length === 0 ? entries : [...entries].sort((a, b) => compareEntries(a, b, sortRules)),
    [entries, sortRules],
  )
  const selectedEntries = useMemo(
    () => sortedEntries.filter(entry => selectedPaths.includes(entry.path)),
    [selectedPaths, sortedEntries],
  )
  const deleteEntries = useMemo(
    () => entries.filter(entry => deletePaths?.includes(entry.path)),
    [deletePaths, entries],
  )
  const deleteSize = useMemo(
    () => deleteEntries.reduce((total, entry) => total + (entry.type === 'directory' ? 0 : entry.size), 0),
    [deleteEntries],
  )

  const toggleSort = useCallback((key: SortKey) => {
    setSortRules(rules => {
      const existing = rules.find(rule => rule.key === key)
      if (!existing) return [...rules, { key, direction: 'asc' }]
      if (existing.direction === 'asc') {
        return rules.map(rule => rule.key === key ? { key, direction: 'desc' } : rule)
      }
      return rules.filter(rule => rule.key !== key)
    })
  }, [])

  const startRename = useCallback((entry: SFTPEntry) => {
    setRenamePath(entry.path)
    setRenameValue(entry.name)
    setContextMenu(null)
  }, [])

  const confirmRename = useCallback(() => {
    if (!renamePath || !renameValue.trim()) {
      setRenamePath(null)
      return
    }
    rename(renamePath, joinName(path, renameValue.trim()))
    setRenamePath(null)
  }, [rename, renamePath, renameValue, path])

  const openEntry = useCallback((entry: SFTPEntry) => {
    if (entry.type === 'directory') list(entry.path)
    else void download(entry)
  }, [download, list])

  const openPermissions = useCallback((entry: SFTPEntry) => {
    loadAccounts()
    setChmodDialog({
      entry,
      mode: (entry.mode ?? 0) & 0o7777,
      uid: entry.uid == null ? '' : String(entry.uid),
      gid: entry.gid == null ? '' : String(entry.gid),
    })
    setContextMenu(null)
  }, [loadAccounts])

  const applyPermissions = useCallback(() => {
    if (!chmodDialog) return
    const nextUid = Number(chmodDialog.uid)
    const nextGid = Number(chmodDialog.gid)
    const ownerChanged = ownershipInputValid(chmodDialog.uid, chmodDialog.gid)
      && chmodDialog.uid.trim() !== ''
      && chmodDialog.gid.trim() !== ''
      && (nextUid !== chmodDialog.entry.uid || nextGid !== chmodDialog.entry.gid)
    if (chmodDialog.mode !== ((chmodDialog.entry.mode ?? 0) & 0o7777)) {
      chmod(chmodDialog.entry.path, chmodDialog.mode)
    }
    if (ownerChanged) {
      chown(chmodDialog.entry.path, nextUid, nextGid)
    }
    setChmodDialog(null)
  }, [chmod, chmodDialog, chown])

  const handleRowClick = useCallback((event: React.MouseEvent, entry: SFTPEntry) => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelected(tabId, entry.path)
      return
    }
    if (selectedPaths.includes(entry.path)) {
      toggleSelected(tabId, entry.path)
      return
    }
    setSelected(tabId, [entry.path])
  }, [selectedPaths, setSelected, tabId, toggleSelected])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const selected = selectedEntries[0]
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelected(tabId, sortedEntries.map(entry => entry.path))
    } else if (event.key === 'Escape') {
      clearSelected(tabId)
      setRenamePath(null)
      setContextMenu(null)
    } else if (event.key === 'Backspace') {
      event.preventDefault()
      list(parentPath(path))
    } else if (event.key === 'Enter' && selected) {
      openEntry(selected)
    } else if (event.key === 'F2' && selected) {
      startRename(selected)
    } else if (event.key === 'Delete' && selectedPaths.length) {
      setDeletePaths(selectedPaths)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && sortedEntries.length) {
      event.preventDefault()
      const currentIndex = selected ? sortedEntries.findIndex(entry => entry.path === selected.path) : -1
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = Math.max(0, Math.min(sortedEntries.length - 1, currentIndex + delta))
      setSelected(tabId, [sortedEntries[nextIndex].path])
    }
  }, [clearSelected, list, openEntry, parentPath, path, selectedEntries, selectedPaths, setSelected, sortedEntries, startRename, tabId])

  const confirmDelete = useCallback(() => {
    if (!deletePaths?.length) return
    remove(deletePaths)
    setDeletePaths(null)
    clearSelected(tabId)
  }, [clearSelected, deletePaths, remove, tabId])

  const createFolder = useCallback(() => {
    const name = newFolderName.trim()
    if (!name) return
    mkdir(name)
    setNewFolderName('')
    setNewFolderOpen(false)
  }, [mkdir, newFolderName])

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface-950 text-slate-200">
      <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-surface-800 px-2 max-[600px]:h-12">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" onClick={() => list(parentPath(path))} title="Go to parent folder (Backspace)">
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          {editingPath ? (
            <PathInput
              key={`${path}-${error ?? ''}`}
              inputRef={pathInputRef}
              path={path}
              error={error}
              list={list}
              onCancel={() => setEditingPath(false)}
            />
          ) : (
            <Breadcrumbs path={path} list={list} onEdit={() => setEditingPath(true)} />
          )}
          {sortRules.length > 0 && (
            <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="secondary" size="sm" title="Reset sort" aria-label="Reset sort" onClick={() => setSortRules([])}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden min-[720px]:inline">Reset sort</span>
            </Button>
          )}
          {username && (
            <span className="max-w-24 flex-shrink truncate text-xs font-medium text-slate-300 sm:max-w-40" title={`Connected as ${username}`}>
              {username}
            </span>
          )}
          {isRoot && (
            <span className="flex flex-shrink-0 items-center gap-1 text-[11px] font-medium text-red-300 opacity-70" title="SFTP connection authenticated as root">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> ROOT
            </span>
          )}
        </div>
        <div className="relative flex flex-shrink-0 items-center gap-1">
          <Button className="max-[600px]:hidden" variant="ghost" size="sm" title="Refresh current folder" onClick={() => list(path)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button className="max-[600px]:hidden" variant="ghost" size="sm" onClick={() => setNewFolderOpen(true)} title="Create new folder">
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New Folder</span>
          </Button>
          <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" title="Upload files" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
          <Button
            ref={moreButtonRef}
            className="min-[601px]:hidden max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0"
            variant="ghost"
            size="sm"
            title="More actions"
            aria-label="More actions"
            aria-expanded={moreActionsOpen}
            aria-controls="sftp-more-actions"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              setHelpOpen(false)
              setMoreActionsOpen(value => !value)
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {moreActionsOpen && (
            <div
              ref={moreMenuRef}
              id="sftp-more-actions"
              role="menu"
              aria-label="More actions"
              className="absolute right-0 top-12 z-40 w-40 rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl"
              onPointerDown={event => event.stopPropagation()}
              onKeyDown={event => moveMenuFocus(event, moreMenuRef.current, () => closeMoreMenu(true))}
            >
              <button type="button" role="menuitem" onClick={() => { list(path); closeMoreMenu(true) }} className="flex h-11 w-full items-center gap-2 px-3 text-left text-xs text-slate-300 hover:bg-surface-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500">
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
              <button type="button" role="menuitem" onClick={() => { closeMoreMenu(true); setNewFolderOpen(true) }} className="flex h-11 w-full items-center gap-2 px-3 text-left text-xs text-slate-300 hover:bg-surface-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500">
                <FolderPlus className="h-3.5 w-3.5" /> New folder
              </button>
            </div>
          )}
          {selectedPaths.length > 0 && (
            <div className="mx-1 h-5 border-l border-surface-800" />
          )}
          {selectedPaths.length > 0 && (
            <>
              <span className="hidden text-[11px] text-slate-500 min-[720px]:inline">{selectedPaths.length} selected</span>
              <button
                type="button"
                onClick={() => clearSelected(tabId)}
                className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:h-11 max-[600px]:w-11"
                title="Clear selection"
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              {selectedEntries.length === 1 && selectedEntries[0].type !== 'directory' && (
                <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" onClick={() => void download(selectedEntries[0])} title="Download selected file">
                  <Download className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="danger" size="sm" onClick={() => setDeletePaths(selectedPaths)} title="Delete selection (Delete)">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            ref={helpButtonRef}
            className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0"
            variant="ghost"
            size="sm"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            aria-expanded={helpOpen}
            aria-controls="sftp-shortcuts"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); setMoreActionsOpen(false); setHelpOpen(value => !value) }}
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </Button>
          {helpOpen && (
            <div ref={helpMenuRef} id="sftp-shortcuts" className="absolute right-0 top-8 z-40 w-64 rounded-lg border border-surface-700 bg-surface-800 p-3 shadow-xl" onPointerDown={event => event.stopPropagation()}>
              <p className="mb-2 text-xs font-medium text-slate-200">Keyboard shortcuts</p>
              <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-[11px] text-slate-400">
                <span className="font-mono text-slate-300">Ctrl+L</span><span>Edit path</span>
                <span className="font-mono text-slate-300">Enter</span><span>Open selection</span>
                <span className="font-mono text-slate-300">Backspace</span><span>Go to parent</span>
                <span className="font-mono text-slate-300">F2</span><span>Rename</span>
                <span className="font-mono text-slate-300">Delete</span><span>Delete selection</span>
                <span className="font-mono text-slate-300">Ctrl+A</span><span>Select all</span>
                <span className="font-mono text-slate-300">Arrows</span><span>Move selection</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={event => {
          if (event.target.files) {
            clearDropFeedback()
            void uploadFiles(event.target.files)
          }
          event.currentTarget.value = ''
        }}
      />

      {dropWaitState && (
        <div
          className="flex min-h-9 flex-shrink-0 items-center gap-2 border-b border-surface-800 border-l-2 border-l-brand-400 bg-surface-900 px-3 py-1.5 font-mono text-[11px] text-slate-300"
        >
          {dropWaitState === 'preparing' ? (
            <LoaderCircle className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-brand-400 motion-reduce:animate-none" />
          ) : (
            <CircleAlert className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
          )}
          <span role="status" aria-live="polite" className="min-w-0 flex-1">
            {dropWaitState === 'preparing' ? 'Preparing upload…' : "Upload hasn't started yet."}
          </span>
          {dropWaitState === 'delayed' && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 flex-shrink-0 items-center px-2 font-sans text-xs font-medium text-brand-300 hover:text-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Choose files
            </button>
          )}
          <button
            type="button"
            onClick={clearDropFeedback}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Dismiss upload status"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {statusNotice && <StatusRail {...statusNotice} onDismiss={dismissStatusNotice} />}

      <div
        ref={listRef}
        role="listbox"
        aria-label="File browser"
        aria-multiselectable="true"
        aria-activedescendant={selectedEntries[0] ? `sftp-entry-${tabId}-${encodeURIComponent(selectedEntries[0].path)}` : undefined}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={event => {
          if (event.target === event.currentTarget) clearSelected(tabId)
        }}
        onDragOver={event => { event.preventDefault(); refreshDragOverlay() }}
        onDragLeave={event => { if (event.currentTarget === event.target) clearDropFeedback() }}
        onDrop={event => {
          event.preventDefault()
          clearDropFeedback()
          void uploadFiles(event.dataTransfer.files)
        }}
        className={clsx('relative min-h-0 flex-1 select-none overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-brand-500', {
          'pointer-events-none opacity-50': disconnected,
        })}
      >
        {loading && entries.length === 0 && (
          <div className="p-2">
            {[0, 1, 2].map(row => (
              <div key={row} className="mb-2 grid h-8 animate-pulse grid-cols-[24px_minmax(0,1fr)_96px_104px_112px_144px] items-center gap-2 opacity-50 max-[600px]:grid-cols-[24px_minmax(0,1fr)]">
                <div className="h-4 w-4 bg-surface-800" />
                <div className="h-3 w-3/5 bg-surface-800" />
                <div className="h-3 bg-surface-800 max-[600px]:hidden" />
                <div className="h-3 bg-surface-800 max-[600px]:hidden" />
                <div className="h-3 bg-surface-800 max-[600px]:hidden" />
                <div className="h-3 bg-surface-800 max-[600px]:hidden" />
              </div>
            ))}
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">This folder is empty</div>
        )}

        {entries.length > 0 && (
          <m.div key={path} {...fade} transition={exitTransition} className={clsx({ 'pointer-events-none opacity-60': loading })} aria-busy={loading}>
            <div className="sticky top-0 z-10 grid h-8 grid-cols-[24px_minmax(0,1fr)_96px_104px_112px_144px] items-center gap-2 border-b border-surface-800 bg-surface-950 px-2 font-mono text-[11px] font-medium text-slate-500 max-[600px]:grid-cols-[24px_minmax(0,1fr)]">
              <button type="button" className="col-span-2 flex h-full min-w-0 items-center gap-1 pl-[32px] text-left hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:pl-0" onClick={() => toggleSort('name')} title="Sort by name">
                <span>name</span><SortIndicator rules={sortRules} sortKey="name" />
              </button>
              <button type="button" className="flex h-full min-w-0 items-center gap-1 text-left hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:hidden" onClick={() => toggleSort('size')} title="Sort by size">
                <span>size</span><SortIndicator rules={sortRules} sortKey="size" />
              </button>
              <button type="button" className="flex h-full min-w-0 items-center gap-1 text-left hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:hidden" onClick={() => toggleSort('owner')} title="Sort by owner">
                <span>owner</span><SortIndicator rules={sortRules} sortKey="owner" />
              </button>
              <button type="button" className="flex h-full min-w-0 items-center gap-1 text-left hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:hidden" onClick={() => toggleSort('mode')} title="Sort by permissions">
                <span>permissions</span><SortIndicator rules={sortRules} sortKey="mode" />
              </button>
              <button type="button" className="flex h-full min-w-0 items-center gap-1 text-left hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:hidden" onClick={() => toggleSort('mtime')} title="Sort by date">
                <span>date</span><SortIndicator rules={sortRules} sortKey="mtime" />
              </button>
            </div>
            {sortedEntries.map((entry) => {
              const selected = selectedPaths.includes(entry.path)
              return (
                <div
                  key={entry.path}
                  id={`sftp-entry-${tabId}-${encodeURIComponent(entry.path)}`}
                  role="option"
                  aria-selected={selected}
                  aria-label={`${entry.name}, ${formatSize(entry)}, owner ${formatOwnership(entry)}, permissions ${permissionTitle(entry.mode)}, ${entry.type}`}
                  tabIndex={-1}
                  onClick={event => handleRowClick(event, entry)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    provideContextFeedback()
                    if (!selected) setSelected(tabId, [entry.path])
                    contextMenuTriggerRef.current = event.currentTarget
                    setContextMenu({
                      x: Math.min(event.clientX, window.innerWidth - 190),
                      y: Math.min(event.clientY, window.innerHeight - 230),
                      entry,
                    })
                  }}
                  className={clsx('grid min-h-8 cursor-default grid-cols-[24px_minmax(0,1fr)_96px_104px_112px_144px] items-center gap-2 px-2 py-1 font-mono text-xs max-[600px]:min-h-11 max-[600px]:grid-cols-[24px_minmax(0,1fr)]', {
                    'bg-brand-500/10 hover:bg-brand-500/20': selected,
                    'hover:bg-surface-800': !selected,
                  })}
                >
                  <FileIcon entry={entry} />
                  {renamePath === entry.path ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={event => setRenameValue(event.target.value)}
                      onBlur={confirmRename}
                      onKeyDown={event => {
                        if (event.key === 'Enter') confirmRename()
                        if (event.key === 'Escape') setRenamePath(null)
                      }}
                      className="min-w-0 border border-brand-500 bg-surface-950 px-1 text-xs text-slate-200 outline-none"
                    />
                  ) : (
                    <span className="min-w-0 break-all leading-5 text-slate-200">{entry.name}</span>
                  )}
                  <span className="text-left text-slate-500 max-[600px]:hidden">{formatSize(entry)}</span>
                  <span className="text-left text-slate-500 max-[600px]:hidden" title={ownershipTitle(entry)}>{formatOwnership(entry)}</span>
                  <span className="text-left text-slate-400 max-[600px]:hidden" title={permissionTitle(entry.mode)}>{formatMode(entry.mode)}</span>
                  <span className="text-left text-slate-500 max-[600px]:hidden">{formatDate(entry.mtime)}</span>
                </div>
              )
            })}
          </m.div>
        )}

        {loading && entries.length > 0 && (
          <m.div {...fade} role="status" className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-8 items-center justify-center border-b border-surface-800 bg-surface-950/75 text-[11px] text-slate-400 backdrop-blur-sm">
            <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Loading folder…
          </m.div>
        )}

        {dragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-brand-500/20 text-xs font-medium text-brand-100">
            Drop files to upload
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 w-44 rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
          role="menu"
          aria-label="File actions"
          onKeyDown={event => moveMenuFocus(event, contextMenuRef.current, () => closeContextMenu(true))}
        >
          {[
            { label: 'Open', icon: FolderOpen, action: () => openEntry(contextMenu.entry) },
            { label: 'Rename', icon: Pencil, action: () => startRename(contextMenu.entry) },
            { label: 'Permissions', icon: ShieldCheck, action: () => openPermissions(contextMenu.entry) },
            ...(contextMenu.entry.type === 'directory' ? [] : [{ label: 'Download', icon: Download, action: () => void download(contextMenu.entry) }]),
            { label: 'Delete', icon: Trash2, action: () => setDeletePaths([contextMenu.entry.path]), danger: true },
          ].map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                contextMenuTriggerRef.current?.focus()
                item.action()
                setContextMenu(null)
              }}
              className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 max-[600px]:h-11', {
                'text-red-300': item.danger,
                'text-slate-300': !item.danger,
              })}
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          ))}
        </div>
      )}

      {disconnected && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-surface-950/80">
          <p className="text-xs text-slate-300">SSH connection lost</p>
          <Button variant="primary" size="sm" onClick={open} aria-label="Reconnect SSH session">Reconnect</Button>
        </div>
      )}

      <TransferQueue
        transfers={transfers}
        onDismiss={removeTransfer}
        onRetry={retryUpload}
        onClearCompleted={() => {
          for (const transfer of transfers) {
            if (transfer.status === 'done' || transfer.status === 'error') removeTransfer(transfer.id)
          }
        }}
      />

      {newFolderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setNewFolderOpen(false) }}>
          <div ref={newFolderDialogRef} role="dialog" aria-modal="true" aria-labelledby="new-folder-title" tabIndex={-1} className="flex w-full max-w-xs flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl">
            <div>
              <h2 id="new-folder-title" className="text-xs font-medium text-slate-200">New folder</h2>
              <p className="mt-1 text-[11px] text-slate-500">Create inside {path}</p>
            </div>
            <label htmlFor="new-folder-name" className="text-[11px] font-medium text-slate-400">Folder name</label>
            <input
              id="new-folder-name"
              ref={folderInputRef}
              value={newFolderName}
              onChange={event => setNewFolderName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') createFolder()
              }}
              className="rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 max-[600px]:h-11"
              placeholder="Folder name"
            />
            <div className="flex gap-2">
              <Button className="flex-1 max-[600px]:h-11" variant="secondary" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
              <Button className="flex-1 max-[600px]:h-11" variant="primary" disabled={!newFolderName.trim()} onClick={createFolder}>Create</Button>
            </div>
          </div>
        </div>
      )}

      {chmodDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setChmodDialog(null) }}>
          <div ref={chmodDialogRef} role="dialog" aria-modal="true" aria-labelledby="permissions-title" tabIndex={-1} className="flex w-full max-w-[360px] flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl">
            <div>
              <h2 id="permissions-title" className="text-xs font-medium text-slate-200">Permissions</h2>
              <p className="mt-1 truncate font-mono text-[11px] text-slate-500">{chmodDialog.entry.path}</p>
            </div>
            <div className="grid grid-cols-[72px_repeat(3,1fr)] gap-2 text-xs">
              <span />
              {['Read', 'Write', 'Execute'].map(label => <span key={label} className="text-center text-[11px] text-slate-500">{label}</span>)}
              {['Owner', 'Group', 'Other'].map((scope, row) => (
                <div key={scope} className="contents">
                  <span className="self-center text-[11px] font-medium text-slate-400">{scope}</span>
                  {PERMISSION_BITS.slice(row * 3, row * 3 + 3).map(permission => (
                    <label key={permission.bit} className="flex h-8 items-center justify-center rounded-md border border-surface-700 bg-surface-950 max-[600px]:h-11">
                      <input
                        type="checkbox"
                        checked={Boolean(chmodDialog.mode & permission.bit)}
                        onChange={() => setChmodDialog(dialog => dialog ? { ...dialog, mode: dialog.mode ^ permission.bit } : null)}
                        aria-label={`${permission.scope} ${permission.label}`}
                        className="h-3.5 w-3.5 accent-brand-500"
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-[11px] font-medium text-slate-400">Special permissions</p>
              <div className="grid grid-cols-3 gap-2">
                {SPECIAL_PERMISSION_BITS.map(permission => (
                  <label key={permission.bit} className="flex h-8 items-center justify-center gap-2 rounded-md border border-surface-700 bg-surface-950 text-[11px] text-slate-400 max-[600px]:h-11">
                    <input
                      type="checkbox"
                      checked={Boolean(chmodDialog.mode & permission.bit)}
                      onChange={() => setChmodDialog(dialog => dialog ? { ...dialog, mode: dialog.mode ^ permission.bit } : null)}
                      aria-label={permission.label}
                      className="h-3.5 w-3.5 accent-brand-500"
                    />
                    {permission.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-medium text-slate-400">Ownership</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-slate-500">Owner</span>
                  {users.length > 0 ? (
                    <select
                      value={chmodDialog.uid}
                      onChange={event => setChmodDialog(dialog => dialog ? { ...dialog, uid: event.target.value } : null)}
                      className="h-8 rounded-md border border-surface-700 bg-surface-950 px-2 text-xs text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 max-[600px]:h-11"
                      aria-label="Owner"
                    >
                      {!users.some(user => String(user.uid) === chmodDialog.uid) && chmodDialog.uid !== '' && (
                        <option value={chmodDialog.uid}>{chmodDialog.entry.owner ?? chmodDialog.uid}</option>
                      )}
                      {users.map(user => <option key={user.uid} value={String(user.uid)}>{user.name}</option>)}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={chmodDialog.uid}
                      onChange={event => setChmodDialog(dialog => dialog ? { ...dialog, uid: event.target.value } : null)}
                      className="h-8 rounded-md border border-surface-700 bg-surface-950 px-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 max-[600px]:h-11"
                      aria-label="Owner UID"
                    />
                  )}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-slate-500">Group</span>
                  {groups.length > 0 ? (
                    <select
                      value={chmodDialog.gid}
                      onChange={event => setChmodDialog(dialog => dialog ? { ...dialog, gid: event.target.value } : null)}
                      className="h-8 rounded-md border border-surface-700 bg-surface-950 px-2 text-xs text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 max-[600px]:h-11"
                      aria-label="Group"
                    >
                      {!groups.some(group => String(group.gid) === chmodDialog.gid) && chmodDialog.gid !== '' && (
                        <option value={chmodDialog.gid}>{chmodDialog.entry.group ?? chmodDialog.gid}</option>
                      )}
                      {groups.map(group => <option key={group.gid} value={String(group.gid)}>{group.name}</option>)}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={chmodDialog.gid}
                      onChange={event => setChmodDialog(dialog => dialog ? { ...dialog, gid: event.target.value } : null)}
                      className="h-8 rounded-md border border-surface-700 bg-surface-950 px-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 max-[600px]:h-11"
                      aria-label="Group GID"
                    />
                  )}
                </label>
              </div>
              {!ownershipInputValid(chmodDialog.uid, chmodDialog.gid) && (
                <p className="mt-2 text-[11px] text-red-300">Enter numeric UID and GID, or leave both blank.</p>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-surface-800 pt-3 font-mono text-xs">
              <span className="text-slate-300">{symbolicMode(chmodDialog.mode)}</span>
              <span className="font-medium text-brand-400">
                {(users.find(user => String(user.uid) === chmodDialog.uid)?.name ?? chmodDialog.uid.trim()) || '-'}
                :
                {(groups.find(group => String(group.gid) === chmodDialog.gid)?.name ?? chmodDialog.gid.trim()) || '-'} {formatMode(chmodDialog.mode)}
              </span>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1 max-[600px]:h-11" variant="secondary" onClick={() => setChmodDialog(null)}>Cancel</Button>
              <Button
                className="flex-1 max-[600px]:h-11"
                variant="primary"
                disabled={!ownershipInputValid(chmodDialog.uid, chmodDialog.gid)}
                onClick={applyPermissions}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}

      {deletePaths && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setDeletePaths(null) }}>
          <div ref={deleteDialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-title" tabIndex={-1} className="flex w-full max-w-xs flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl">
            <div>
              <h2 id="delete-title" className="text-sm font-semibold text-slate-200">Delete {deletePaths.length === 1 ? 'item' : `${deletePaths.length} items`}?</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                {deletePaths.length === 1
                  ? `Permanently remove "${deletePaths[0].split('/').pop()}" from the remote server.`
                  : `Permanently remove ${deletePaths.length} items${deleteSize ? ` totaling ${formatBytes(deleteSize)}` : ''} from the remote server.`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button ref={deleteCancelRef} className="flex-1 max-[600px]:h-11" variant="secondary" onClick={() => setDeletePaths(null)}>Cancel</Button>
              <Button className="flex-1 max-[600px]:h-11" variant="danger" onClick={confirmDelete}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
