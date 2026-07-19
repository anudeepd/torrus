import { useMemo, useRef, useState } from 'react'
import { Columns2, Folder, Plus, Radio, Search, Settings, Terminal, X } from 'lucide-react'
import { useDialogPresence } from '@/hooks/useDialogPresence'
import type { Tab } from '@/types'
import { modKey } from '@/utils/platform'
import * as m from 'motion/react-m'
import { fade, surface, surfaceSpring } from '@/motion/tokens'

interface CommandPaletteProps {
  tabs: Tab[]
  activeTabId: string | null
  canSplit: boolean
  canBroadcast: boolean
  inSplitMode: boolean
  onAddTab: () => void
  onSelectTab: (id: string) => void
  onOpenSettings: () => void
  onOpenSplitPicker: () => void
  onOpenBroadcastPicker: () => void
  onExitSplit: () => void
  onClose: () => void
}

function tabName(tab: Tab) {
  if (tab.label) return tab.label
  if (tab.type === 'sftp') return 'SFTP'
  if (tab.host && tab.username) return `${tab.username}@${tab.host}`
  return 'New Connection'
}

export default function CommandPalette({ tabs, activeTabId, canSplit, canBroadcast, inSplitMode, onAddTab, onSelectTab, onOpenSettings, onOpenSplitPicker, onOpenBroadcastPicker, onExitSplit, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { ref: dialogRef, presenceProps } = useDialogPresence(onClose, inputRef)

  const commands = useMemo(() => {
    const items = [
      { id: 'new-terminal', label: 'New terminal tab', detail: `${modKey}+T`, icon: Plus, run: onAddTab },
      ...(inSplitMode
        ? [{ id: 'exit-split', label: 'Exit split mode', detail: 'Layout', icon: X, run: onExitSplit }]
        : canSplit ? [{ id: 'split', label: 'Create split layout', detail: 'Layout', icon: Columns2, run: onOpenSplitPicker }] : []),
      ...tabs.map(tab => ({
        id: `tab-${tab.id}`,
        label: `Switch to ${tabName(tab)}`,
        detail: tab.type === 'sftp' ? 'SFTP' : tab.status,
        icon: tab.type === 'sftp' ? Folder : Terminal,
        run: () => onSelectTab(tab.id),
      })),
      ...(canBroadcast ? [{ id: 'broadcast', label: 'Manage broadcast input', detail: 'Terminals', icon: Radio, run: onOpenBroadcastPicker }] : []),
      { id: 'settings', label: 'Open settings', detail: `${modKey}+,`, icon: Settings, run: onOpenSettings },
    ]
    const normalized = query.trim().toLowerCase()
    return normalized ? items.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(normalized)) : items
  }, [canBroadcast, canSplit, inSplitMode, onAddTab, onExitSplit, onOpenBroadcastPicker, onOpenSettings, onOpenSplitPicker, onSelectTab, query, tabs])

  const run = (command: typeof commands[number] | undefined) => {
    if (!command) return
    command.run()
    onClose()
  }

  return (
    <m.div {...fade} className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 px-4 pt-[min(22vh,9rem)] backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <m.div {...surface} {...presenceProps} transition={surfaceSpring} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Command Palette" tabIndex={-1} className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-2xl">
        <div className="border-b border-surface-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-200">Command Palette</h2>
        </div>
        <label className="m-4 mb-3 flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2.5 text-slate-400 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500">
          <Search className="h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={event => { setQuery(event.target.value); setSelectedIndex(0) }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex(index => Math.min(index + 1, commands.length - 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex(index => Math.max(index - 1, 0)) }
              if (event.key === 'Enter') { event.preventDefault(); run(commands[selectedIndex]) }
            }}
            placeholder="Search commands and tabs"
            aria-label="Search commands and tabs"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
        </label>
        <div className="mx-4 mb-4 max-h-80 overflow-y-auto rounded-lg border border-surface-700 p-1" role="listbox" aria-label="Commands">
          {commands.length === 0 ? <p className="px-3 py-6 text-center text-sm text-slate-500">No matching commands</p> : commands.map((command, index) => {
            const Icon = command.icon
            const active = command.id === `tab-${activeTabId}`
            return (
              <button key={command.id} type="button" role="option" aria-selected={index === selectedIndex} onMouseEnter={() => setSelectedIndex(index)} onClick={() => run(command)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${index === selectedIndex ? 'bg-brand-600/25 text-slate-100' : 'text-slate-300 hover:bg-surface-800'} ${active ? 'border-l-2 border-brand-400' : ''}`}>
                <Icon className="h-4 w-4 shrink-0 text-brand-400" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="max-w-[35%] truncate text-xs text-slate-500">{command.detail}</span>
              </button>
            )
          })}
        </div>
      </m.div>
    </m.div>
  )
}
