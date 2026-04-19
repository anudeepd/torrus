import { useState, useEffect } from 'react'
import { Radio, X } from 'lucide-react'
import clsx from 'clsx'
import type { PaneNode } from '@/store/layoutStore'
import { makeSplitId } from '@/store/layoutStore'
import type { Tab } from '@/types'

// ─── Auto-layout for N terminals ───────────────────────────────────────────

function leaf(tabId: string): PaneNode { return { type: 'leaf', tabId } }
function h(a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'h', ratio: 0.5, a, b }
}
function v(a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'v', ratio: 0.5, a, b }
}

function autoLayout(tabIds: string[]): PaneNode | null {
  if (tabIds.length === 0) return null
  if (tabIds.length === 1) return leaf(tabIds[0])
  if (tabIds.length === 2) return h(leaf(tabIds[0]), leaf(tabIds[1]))
  if (tabIds.length === 3) return h(leaf(tabIds[0]), v(leaf(tabIds[1]), leaf(tabIds[2])))
  if (tabIds.length === 4) return h(v(leaf(tabIds[0]), leaf(tabIds[2])), v(leaf(tabIds[1]), leaf(tabIds[3])))
  // 5+: left col of 2 + right col of rest (recursed)
  const right = autoLayout(tabIds.slice(2))
  if (!right) return null
  return h(v(leaf(tabIds[0]), leaf(tabIds[1])), right)
}

// ─── Modal ──────────────────────────────────────────────────────────────────

interface Props {
  connectedTabs: Tab[]
  initialIncluded: Set<string>   // tabs currently included in broadcast
  broadcastEnabled: boolean
  onApply: (includedTabIds: string[], layout: PaneNode | null) => void
  onDisable: () => void
  onClose: () => void
}

export default function BroadcastPickerModal({ connectedTabs, initialIncluded, broadcastEnabled, onApply, onDisable, onClose }: Props) {
  const [checked, setChecked] = useState<Set<string>>(() =>
    broadcastEnabled && initialIncluded.size > 0
      ? new Set(initialIncluded)
      : new Set(connectedTabs.map(t => t.id))
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: string) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const selectedIds = connectedTabs.filter(t => checked.has(t.id)).map(t => t.id)

  const handleApply = () => {
    const layout = autoLayout(selectedIds)
    onApply(selectedIds, layout)
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-80 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-200">Broadcast input</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <p className="text-xs text-slate-400">
            Select terminals to broadcast to. All selected terminals will be shown simultaneously in split view.
          </p>

          {/* Terminal checkboxes */}
          <div className="flex flex-col gap-1.5">
            {connectedTabs.map(tab => {
              const label = tab.label ?? (tab.host && tab.username ? `${tab.username}@${tab.host}` : 'Connection')
              const isChecked = checked.has(tab.id)
              return (
                <label
                  key={tab.id}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                    isChecked ? 'bg-amber-400/10 border border-amber-400/30' : 'bg-surface-800 border border-surface-700'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(tab.id)}
                    className="accent-amber-400"
                  />
                  <span className="text-xs text-slate-200 font-mono truncate">{label}</span>
                </label>
              )
            })}
          </div>

          {selectedIds.length >= 2 && (
            <p className="text-xs text-slate-500">
              {selectedIds.length} terminals selected — will auto-arrange in split view.
            </p>
          )}
          {selectedIds.length === 1 && (
            <p className="text-xs text-amber-400/80">Select at least 2 terminals to broadcast.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 px-5 pb-5">
          <button
            onClick={handleApply}
            disabled={selectedIds.length < 2}
            className="w-full px-3 py-2 rounded-md text-sm font-medium text-white bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Start broadcast
          </button>
          {broadcastEnabled && (
            <button
              onClick={onDisable}
              className="w-full px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-red-400 transition-colors"
            >
              Disable broadcast
            </button>
          )}
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-md text-sm text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
