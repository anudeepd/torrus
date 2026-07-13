import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowUp, Download, FolderPlus, RefreshCw, Trash2, Upload } from 'lucide-react'
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

function formatSize(entry: SFTPEntry): string {
  if (entry.type === 'directory') return ''
  if (entry.size < 1024) return `${entry.size} B`
  const units = ['KB', 'MB', 'GB']
  let value = entry.size / 1024
  let unit = units[0]
  for (let i = 1; value >= 1024 && i < units.length; i++) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
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

function pathSegments(path: string): { label: string; path: string }[] {
  if (!path || path === '.') return [{ label: '~', path: '.' }]
  const absolute = path.startsWith('/')
  const parts = path.split('/').filter(Boolean)
  const segments = parts.map((part, index) => ({
    label: part,
    path: `${absolute ? '/' : ''}${parts.slice(0, index + 1).join('/')}`,
  }))
  return [{ label: absolute ? '/' : '~', path: absolute ? '/' : '.' }, ...segments]
}

function joinName(path: string, name: string): string {
  if (!path || path === '.') return name
  return `${path.replace(/\/$/, '')}/${name}`
}

export default function SFTPBrowser({ tabId, sourceTabId, socket }: SFTPBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletePaths, setDeletePaths] = useState<string[] | null>(null)
  const {
    path,
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
    parentPath,
  } = useSFTP(tabId, sourceTabId, socket)
  const { toggleSelected, setSelected, clearSelected } = useSFTPStore()

  const selectedEntries = useMemo(
    () => entries.filter(entry => selectedPaths.includes(entry.path)),
    [entries, selectedPaths],
  )

  const breadcrumbs = useMemo(() => {
    const segments = pathSegments(path)
    if (segments.length <= 5) return segments
    return [segments[0], { label: '...', path }, ...segments.slice(-2)]
  }, [path])

  const startRename = useCallback((entry: SFTPEntry) => {
    setRenamePath(entry.path)
    setRenameValue(entry.name)
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
    if (entry.type === 'directory') {
      list(entry.path)
    } else {
      void download(entry)
    }
  }, [download, list])

  const handleRowClick = useCallback((event: React.MouseEvent, entry: SFTPEntry, index: number) => {
    if (event.shiftKey && selectedPaths.length > 0) {
      const last = entries.findIndex(item => item.path === selectedPaths[selectedPaths.length - 1])
      const start = Math.min(last, index)
      const end = Math.max(last, index)
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

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface-950 text-slate-200">
      <div className="flex h-9 flex-shrink-0 items-center justify-between gap-2 border-b border-surface-800 px-2">
        <nav className="flex min-w-0 items-center text-xs" aria-label="Current path">
          {breadcrumbs.map((segment, index) => (
            <span key={`${segment.label}-${index}`} className="flex min-w-0 items-center">
              {index > 0 && <span className="px-1 text-slate-600">/</span>}
              <button
                type="button"
                onClick={() => segment.label !== '...' && list(segment.path)}
                className={clsx('truncate px-1 hover:text-slate-200', {
                  'font-medium text-slate-200': index === breadcrumbs.length - 1,
                  'text-slate-400': index !== breadcrumbs.length - 1,
                  'cursor-default': segment.label === '...',
                })}
              >
                {segment.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" title="Refresh" onClick={() => list(path)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" title="Upload" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
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
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDragOver={event => { event.preventDefault(); setDragging(true) }}
        onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          void uploadFiles(event.dataTransfer.files)
        }}
        className={clsx('relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-brand-500', {
          'pointer-events-none opacity-50': disconnected,
        })}
      >
        {loading && (
          <div className="p-2">
            {[0, 1, 2].map(row => (
              <div key={row} className="mb-2 flex h-8 animate-pulse items-center gap-2 opacity-50">
                <div className="h-4 w-4 bg-surface-700" />
                <div className="h-3 w-3/5 bg-surface-700" />
                <div className="ml-auto h-3 w-20 bg-surface-700" />
              </div>
            ))}
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-sm text-slate-500">This folder is empty</p>
            <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />
              Upload
            </Button>
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div>
            <div className="sticky top-0 z-10 grid h-8 grid-cols-[24px_minmax(0,1fr)_80px_120px] items-center gap-2 bg-surface-950 px-2 font-mono text-xs text-slate-500 max-[600px]:grid-cols-[24px_minmax(0,1fr)]">
              <span />
              <span>name</span>
              <span className="text-right max-[600px]:hidden">size</span>
              <span className="text-right max-[600px]:hidden">date</span>
            </div>
            {entries.map((entry, index) => {
              const selected = selectedPaths.includes(entry.path)
              return (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={selected}
                  aria-label={`${entry.name}, ${formatSize(entry)}, ${entry.type}`}
                  tabIndex={-1}
                  onClick={event => handleRowClick(event, entry, index)}
                  onDoubleClick={() => openEntry(entry)}
                  className={clsx('grid h-8 cursor-default grid-cols-[24px_minmax(0,1fr)_80px_120px] items-center gap-2 px-2 font-mono text-xs max-[600px]:h-7 max-[600px]:grid-cols-[24px_minmax(0,1fr)]', {
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
                      className="min-w-0 rounded border border-brand-500 bg-surface-950 px-1 text-xs text-slate-200 outline-none"
                    />
                  ) : (
                    <span className="min-w-0 truncate text-slate-200">{entry.name}</span>
                  )}
                  <span className="text-right text-slate-500 max-[600px]:hidden">{formatSize(entry)}</span>
                  <span className="text-right text-slate-500 max-[600px]:hidden">{formatDate(entry.mtime)}</span>
                </div>
              )
            })}
          </div>
        )}

        {dragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-brand-500/20 text-sm font-medium text-brand-100">
            Drop files to upload
          </div>
        )}
      </div>

      {disconnected && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-950/80">
          <p className="text-sm text-slate-300">SSH connection lost</p>
          <Button variant="primary" size="sm" onClick={open} aria-label="Reconnect SSH session">
            Reconnect
          </Button>
        </div>
      )}

      {error && (
        <div className="absolute bottom-12 right-3 max-w-sm border border-red-400/20 bg-surface-800 px-3 py-2 text-xs text-red-300 shadow-lg">
          {error}
        </div>
      )}

      <div className="flex h-10 flex-shrink-0 items-center justify-between border-t border-surface-800 px-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} title="Upload">
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden min-[480px]:inline">Upload</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const name = prompt('New folder name')
              if (name?.trim()) mkdir(name.trim())
            }}
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden min-[480px]:inline">New Folder</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => list(parentPath(path))} title="Go up">
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {selectedPaths.length > 0 && <span className="hidden text-xs text-slate-500 min-[480px]:inline">{selectedPaths.length} selected</span>}
          {selectedEntries.length === 1 && selectedEntries[0].type !== 'directory' && (
            <Button variant="ghost" size="sm" onClick={() => void download(selectedEntries[0])} title="Download">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {selectedPaths.length > 0 && (
            <Button variant="danger" size="sm" onClick={() => setDeletePaths(selectedPaths)} title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <TransferQueue transfers={transfers} />

      {deletePaths && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-slate-200">
              Delete {deletePaths.length === 1 ? 'file?' : `${deletePaths.length} files?`}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              {deletePaths.length === 1
                ? `Delete "${deletePaths[0].split('/').pop()}"? This cannot be undone.`
                : `Delete ${deletePaths.length} files? This cannot be undone.`}
            </p>
            <div className="mt-4 flex gap-2">
              <Button className="flex-1" variant="secondary" onClick={() => setDeletePaths(null)}>Cancel</Button>
              <Button className="flex-1" variant="danger" onClick={confirmDelete}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
