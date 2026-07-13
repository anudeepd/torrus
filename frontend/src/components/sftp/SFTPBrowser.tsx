import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  CircleHelp,
  Download,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
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
import { useSFTPStore } from '@/store/sftpStore'
import type { SFTPEntry } from '@/types'

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
}

function provideContextFeedback() {
  if (window.matchMedia?.('(pointer: coarse)').matches) navigator.vibrate?.(10)
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

function symbolicMode(mode: number): string {
  const chars = ['r', 'w', 'x']
  const symbolic = PERMISSION_BITS.map((permission, index) => mode & permission.bit ? chars[index % 3] : '-')
  if (mode & 0o4000) symbolic[2] = mode & 0o100 ? 's' : 'S'
  if (mode & 0o2000) symbolic[5] = mode & 0o010 ? 's' : 'S'
  if (mode & 0o1000) symbolic[8] = mode & 0o001 ? 't' : 'T'
  return symbolic.join('')
}

function joinName(path: string, name: string): string {
  if (!path || path === '.') return name
  return `${path.replace(/\/$/, '')}/${name}`
}

function pathSegments(path: string): Array<{ label: string; path: string }> {
  if (!path || path === '.') return [{ label: '~', path: '~' }]
  if (path === '/') return [{ label: '/', path: '/' }]
  const parts = path.split('/').filter(Boolean)
  return [
    { label: '~', path: '~' },
    ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` })),
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
      {visible.map((segment, index) => (
        <span key={`${segment.path}-${index}`} className="flex min-w-0 items-center">
          {index > 0 && <span className="px-1 text-slate-600">/</span>}
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
              <span className="px-1 text-slate-600">/</span>
            </>
          )}
          <button
            type="button"
            onClick={() => list(segment.path)}
            className={clsx('max-w-32 truncate px-1 font-mono text-xs hover:text-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 max-[600px]:h-10', {
              'font-medium text-brand-400': index === visible.length - 1,
              'text-slate-400': index !== visible.length - 1,
            })}
            title={segment.path}
          >
            {segment.label}
          </button>
        </span>
      ))}
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

export default function SFTPBrowser({ tabId, sourceTabId, socket }: SFTPBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletePaths, setDeletePaths] = useState<string[] | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [chmodDialog, setChmodDialog] = useState<ChmodDialogState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const {
    path,
    username,
    isRoot,
    entries,
    selectedPaths,
    loading,
    error,
    disconnected,
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
  } = useSFTP(tabId, sourceTabId, socket)
  const { toggleSelected, setSelected, clearSelected } = useSFTPStore()

  useEffect(() => {
    if (!editingPath) return
    pathInputRef.current?.focus()
    pathInputRef.current?.select()
  }, [editingPath])

  useEffect(() => {
    if (!newFolderOpen) return
    folderInputRef.current?.focus()
  }, [newFolderOpen])

  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [contextMenu])

  useEffect(() => {
    if (!error) return
    const timeout = window.setTimeout(clearError, 12000)
    return () => window.clearTimeout(timeout)
  }, [clearError, error])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setEditingPath(true)
      } else if (event.key === 'Escape') {
        setContextMenu(null)
        setHelpOpen(false)
      }
    }
    const closeMenu = () => setContextMenu(null)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', closeMenu)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', closeMenu)
    }
  }, [])

  const selectedEntries = useMemo(
    () => entries.filter(entry => selectedPaths.includes(entry.path)),
    [entries, selectedPaths],
  )
  const deleteEntries = useMemo(
    () => entries.filter(entry => deletePaths?.includes(entry.path)),
    [deletePaths, entries],
  )
  const deleteSize = useMemo(
    () => deleteEntries.reduce((total, entry) => total + (entry.type === 'directory' ? 0 : entry.size), 0),
    [deleteEntries],
  )

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
    setChmodDialog({ entry, mode: (entry.mode ?? 0) & 0o7777 })
    setContextMenu(null)
  }, [])

  const handleRowClick = useCallback((event: React.MouseEvent, entry: SFTPEntry, index: number) => {
    if (event.shiftKey && selectedPaths.length > 0) {
      const last = entries.findIndex(item => item.path === selectedPaths[selectedPaths.length - 1])
      const start = Math.min(last < 0 ? index : last, index)
      const end = Math.max(last < 0 ? index : last, index)
      setSelected(tabId, entries.slice(start, end + 1).map(item => item.path))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      toggleSelected(tabId, entry.path)
      return
    }
    setSelected(tabId, [entry.path])
  }, [entries, selectedPaths, setSelected, tabId, toggleSelected])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const selected = selectedEntries[0]
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelected(tabId, entries.map(entry => entry.path))
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
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length) {
      event.preventDefault()
      const currentIndex = selected ? entries.findIndex(entry => entry.path === selected.path) : -1
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + delta))
      setSelected(tabId, [entries[nextIndex].path])
    }
  }, [clearSelected, entries, list, openEntry, parentPath, path, selectedEntries, selectedPaths, setSelected, startRename, tabId])

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
          <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" title="Refresh current folder" onClick={() => list(path)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" title="Upload files" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
          <Button
            className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0"
            variant="ghost"
            size="sm"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); setHelpOpen(value => !value) }}
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </Button>
          {helpOpen && (
            <div className="absolute right-0 top-8 z-40 w-64 border border-surface-800 bg-surface-900 p-3 shadow-2xl" onPointerDown={event => event.stopPropagation()}>
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
          if (event.target.files) void uploadFiles(event.target.files)
          event.currentTarget.value = ''
        }}
      />

      <div
        ref={listRef}
        role="listbox"
        aria-label="File browser"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDragOver={event => { event.preventDefault(); setDragging(true) }}
        onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          void uploadFiles(event.dataTransfer.files)
        }}
        className={clsx('relative min-h-0 flex-1 select-none overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-brand-500', {
          'pointer-events-none opacity-50': disconnected,
        })}
      >
        {loading && (
          <div className="p-2">
            {[0, 1, 2].map(row => (
              <div key={row} className="mb-2 grid h-8 animate-pulse grid-cols-[24px_minmax(0,1fr)_80px_80px_120px] items-center gap-2 opacity-50 max-[600px]:grid-cols-[24px_minmax(0,1fr)]">
                <div className="h-4 w-4 bg-surface-800" />
                <div className="h-3 w-3/5 bg-surface-800" />
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

        {!loading && entries.length > 0 && (
          <div>
            <div className="sticky top-0 z-10 grid h-8 grid-cols-[24px_minmax(0,1fr)_80px_80px_120px] items-center gap-2 border-b border-surface-800 bg-surface-950 px-2 font-mono text-[11px] font-medium text-slate-500 max-[600px]:grid-cols-[24px_minmax(0,1fr)]">
              <span />
              <span>name</span>
              <span className="text-right max-[600px]:hidden">size</span>
              <span className="text-right max-[600px]:hidden">permissions</span>
              <span className="text-right max-[600px]:hidden">date</span>
            </div>
            {entries.map((entry, index) => {
              const selected = selectedPaths.includes(entry.path)
              return (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={selected}
                  aria-label={`${entry.name}, ${formatSize(entry)}, permissions ${formatMode(entry.mode)}, ${entry.type}`}
                  tabIndex={-1}
                  onClick={event => handleRowClick(event, entry, index)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    provideContextFeedback()
                    if (!selected) setSelected(tabId, [entry.path])
                    setContextMenu({
                      x: Math.min(event.clientX, window.innerWidth - 190),
                      y: Math.min(event.clientY, window.innerHeight - 230),
                      entry,
                    })
                  }}
                  className={clsx('grid h-8 cursor-default grid-cols-[24px_minmax(0,1fr)_80px_80px_120px] items-center gap-2 px-2 font-mono text-xs max-[600px]:h-11 max-[600px]:grid-cols-[24px_minmax(0,1fr)]', {
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
                    <span className="min-w-0 truncate text-slate-200">{entry.name}</span>
                  )}
                  <span className="text-right text-slate-500 max-[600px]:hidden">{formatSize(entry)}</span>
                  <span className="text-right text-slate-400 max-[600px]:hidden">{formatMode(entry.mode)}</span>
                  <span className="text-right text-slate-500 max-[600px]:hidden">{formatDate(entry.mtime)}</span>
                </div>
              )
            })}
          </div>
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
          className="fixed z-50 w-44 border border-surface-800 bg-surface-900 py-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
          role="menu"
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
              onClick={() => { item.action(); setContextMenu(null) }}
              className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 max-[600px]:h-11', {
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

      {error && (
        <div className="absolute bottom-12 right-3 z-40 flex max-w-sm items-start gap-2 border border-red-400/20 bg-surface-900 px-3 py-2 text-xs text-red-300 shadow-lg" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={clearError} className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-red-300/70 hover:text-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400" aria-label="Dismiss error">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-t border-surface-800 px-2 max-[600px]:h-12">
        <div className="flex items-center gap-2">
          <Button className="max-[600px]:h-11 max-[600px]:min-w-11" variant="ghost" size="sm" onClick={() => setNewFolderOpen(true)} title="Create new folder">
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden min-[480px]:inline">New Folder</span>
          </Button>
          <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" onClick={() => list(parentPath(path))} title="Go to parent folder (Backspace)">
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {selectedPaths.length > 0 && <span className="hidden text-[11px] text-slate-500 min-[480px]:inline">{selectedPaths.length} selected</span>}
          {selectedEntries.length === 1 && selectedEntries[0].type !== 'directory' && (
            <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="ghost" size="sm" onClick={() => void download(selectedEntries[0])} title="Download selected file">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {selectedPaths.length > 0 && (
            <Button className="max-[600px]:h-11 max-[600px]:w-11 max-[600px]:px-0" variant="danger" size="sm" onClick={() => setDeletePaths(selectedPaths)} title="Delete selection (Delete)">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <TransferQueue transfers={transfers} />

      {newFolderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={event => { if (event.target === event.currentTarget) setNewFolderOpen(false) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="new-folder-title" className="flex w-80 flex-col gap-4 border border-surface-800 bg-surface-900 p-5 shadow-2xl">
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
                if (event.key === 'Escape') setNewFolderOpen(false)
              }}
              className="border border-surface-800 bg-surface-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-brand-500 max-[600px]:h-11"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={event => { if (event.target === event.currentTarget) setChmodDialog(null) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="permissions-title" className="flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-4 border border-surface-800 bg-surface-900 p-5 shadow-2xl">
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
                    <label key={permission.bit} className="flex h-8 items-center justify-center border border-surface-800 bg-surface-950 max-[600px]:h-11">
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
                  <label key={permission.bit} className="flex h-8 items-center justify-center gap-2 border border-surface-800 bg-surface-950 text-[11px] text-slate-400 max-[600px]:h-11">
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
            <div className="flex items-center justify-between border-t border-surface-800 pt-3 font-mono text-xs">
              <span className="text-slate-300">{symbolicMode(chmodDialog.mode)}</span>
              <span className="font-medium text-brand-400">{formatMode(chmodDialog.mode)}</span>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1 max-[600px]:h-11" variant="secondary" onClick={() => setChmodDialog(null)}>Cancel</Button>
              <Button
                className="flex-1 max-[600px]:h-11"
                variant="primary"
                onClick={() => { chmod(chmodDialog.entry.path, chmodDialog.mode); setChmodDialog(null) }}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}

      {deletePaths && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={event => { if (event.target === event.currentTarget) setDeletePaths(null) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="flex w-80 flex-col gap-4 border border-surface-800 bg-surface-900 p-5 shadow-2xl">
            <div>
              <h2 id="delete-title" className="text-xs font-medium text-slate-200">Delete {deletePaths.length === 1 ? 'item' : `${deletePaths.length} items`}?</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                {deletePaths.length === 1
                  ? `Permanently remove "${deletePaths[0].split('/').pop()}" from the remote server.`
                  : `Permanently remove ${deletePaths.length} items${deleteSize ? ` totaling ${formatBytes(deleteSize)}` : ''} from the remote server.`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1 max-[600px]:h-11" variant="secondary" onClick={() => setDeletePaths(null)}>Cancel</Button>
              <Button className="flex-1 max-[600px]:h-11" variant="danger" onClick={confirmDelete}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
