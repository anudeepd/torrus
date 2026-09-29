import Dialog from '@/components/ui/Dialog'
import { useMemo, useRef, useState } from 'react'
import { Columns2, Folder, Plus, Radio, Search, Settings, Terminal, X } from 'lucide-react'
import type { Tab } from '@/types'
import { modKey } from '@/utils/platform'
import { tabDisplayName } from '@/lib/tabName'
import { cn } from '@/lib/cn'

interface CommandPaletteProps {
  tabs: Tab[]
  activeTabId: string | null
  canSplit: boolean
  canBroadcast: boolean
  inSplitMode: boolean
  onAddTab: () => void
  onSelectTab: (id: string) => void
  onOpenSftpTab: (id: string) => void
  onOpenSettings: () => void
  onOpenSplitPicker: () => void
  onOpenBroadcastPicker: () => void
  onExitSplit: () => void
  onClose: () => void
}

export default function CommandPalette({ tabs, activeTabId, canSplit, canBroadcast, inSplitMode, onAddTab, onSelectTab, onOpenSftpTab, onOpenSettings, onOpenSplitPicker, onOpenBroadcastPicker, onExitSplit, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const sftpTarget = tabs.find(tab => tab.id === activeTabId && tab.type === 'terminal' && tab.status === 'connected')

  const commands = useMemo(() => {
    const items = [
      { id: 'new-terminal', label: 'New tab', detail: 'toolbar', icon: Plus, run: onAddTab },
      ...(inSplitMode
        ? [{ id: 'exit-split', label: 'Exit split', detail: 'layout', icon: X, run: onExitSplit }]
        : canSplit ? [{ id: 'split', label: 'Split', detail: 'layout', icon: Columns2, run: onOpenSplitPicker }] : []),
      ...tabs.map(tab => ({
        id: `tab-${tab.id}`,
        label: `Switch to ${tabDisplayName(tab, tabs)}`,
        detail: tab.type === 'sftp' ? 'SFTP' : tab.status,
        icon: tab.type === 'sftp' ? Folder : Terminal,
        run: () => onSelectTab(tab.id),
      })),
      ...(sftpTarget
        ? [{ id: 'open-sftp', label: `Open SFTP for ${tabDisplayName(sftpTarget, tabs)}`, detail: 'files', icon: Folder, run: () => onOpenSftpTab(sftpTarget.id) }]
        : []),
      ...(canBroadcast ? [{ id: 'broadcast', label: 'Manage broadcast input', detail: 'terminals', icon: Radio, run: onOpenBroadcastPicker }] : []),
      { id: 'settings', label: 'Open settings', detail: `${modKey}+,`, icon: Settings, run: onOpenSettings },
    ]
    const normalized = query.trim().toLowerCase()
    return normalized ? items.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(normalized)) : items
  }, [canBroadcast, canSplit, inSplitMode, onAddTab, onExitSplit, onOpenBroadcastPicker, onOpenSettings, onOpenSplitPicker, onOpenSftpTab, onSelectTab, query, sftpTarget, tabs])

  const run = (command: typeof commands[number] | undefined) => {
    if (!command) return
    command.run()
    onClose()
  }

  return (
    <Dialog label="Command palette" onClose={onClose} initialFocus={inputRef} align="top" scrimClassName="bg-black/65 backdrop-blur-[2px]" className="max-w-xl p-0">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
          <h2 className="text-sm font-semibold text-slate-200 text-balance">Command palette</h2>
        </div>
        <label className="m-4 mb-3 flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2.5 text-slate-400 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500">
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            name="command-search"
            autoComplete="off"
            onChange={event => { setQuery(event.target.value); setSelectedIndex(0) }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex(index => Math.min(index + 1, commands.length - 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex(index => Math.max(index - 1, 0)) }
              if (event.key === 'Enter') { event.preventDefault(); run(commands[selectedIndex]) }
            }}
            placeholder="Search commands and tabs…"
            aria-label="Search commands and tabs"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-400"
          />
        </label>
        <div className="mx-4 mb-4 max-h-80 overflow-y-auto overscroll-contain rounded-lg border border-surface-700 p-1" role="listbox" aria-label="Commands">
          {commands.length === 0 ? <p className="px-3 py-6 text-center text-sm text-slate-400 text-pretty">No matching commands</p> : commands.map((command, index) => {
            const Icon = command.icon
            const active = command.id === `tab-${activeTabId}`
            return (
              <button key={command.id} type="button" role="option" aria-selected={index === selectedIndex} onMouseEnter={() => setSelectedIndex(index)} onClick={() => run(command)} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors', index === selectedIndex ? 'bg-brand-600/25 text-slate-100' : 'text-slate-300 hover:bg-surface-800', active && 'ring-1 ring-inset ring-brand-400')}>
                <Icon aria-hidden="true" className="size-4 shrink-0 text-brand-400" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="max-w-[35%] truncate text-xs text-slate-400">{command.detail}</span>
              </button>
            )
          })}
        </div>
    </Dialog>
  )
}
