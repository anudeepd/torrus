import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import type { PaneNode } from '@/store/layoutStore'
import { makeSplitId } from '@/store/layoutStore'
import type { Tab } from '@/types'

// ─── Preset layout builders ────────────────────────────────────────────────

function leaf(tabId: string): PaneNode { return { type: 'leaf', tabId } }
function h(a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'h', ratio, a, b }
}
function v(a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'v', ratio, a, b }
}

type Preset = {
  id: string
  name: string
  slots: number
  build: (ids: string[]) => PaneNode
  thumb: React.ReactNode
}

const PRESETS: Preset[] = [
  {
    id: '2h', name: 'Side by side', slots: 2,
    build: ([a, b]) => h(leaf(a), leaf(b)),
    thumb: (
      <div className="flex gap-0.5 w-full h-full">
        <div className="flex-1 bg-slate-500 rounded-sm" />
        <div className="flex-1 bg-slate-500 rounded-sm" />
      </div>
    ),
  },
  {
    id: '2v', name: 'Top / Bottom', slots: 2,
    build: ([a, b]) => v(leaf(a), leaf(b)),
    thumb: (
      <div className="flex flex-col gap-0.5 w-full h-full">
        <div className="flex-1 bg-slate-500 rounded-sm" />
        <div className="flex-1 bg-slate-500 rounded-sm" />
      </div>
    ),
  },
  {
    id: '3r', name: 'Main + 2 right', slots: 3,
    build: ([a, b, c]) => h(leaf(a), v(leaf(b), leaf(c)), 0.6),
    thumb: (
      <div className="flex gap-0.5 w-full h-full">
        <div style={{ flex: 1.5 }} className="bg-slate-500 rounded-sm" />
        <div className="flex-1 flex flex-col gap-0.5">
          <div className="flex-1 bg-slate-500 rounded-sm" />
          <div className="flex-1 bg-slate-500 rounded-sm" />
        </div>
      </div>
    ),
  },
  {
    id: '3b', name: 'Main + 2 below', slots: 3,
    build: ([a, b, c]) => v(leaf(a), h(leaf(b), leaf(c)), 0.6),
    thumb: (
      <div className="flex flex-col gap-0.5 w-full h-full">
        <div style={{ flex: 1.5 }} className="bg-slate-500 rounded-sm" />
        <div className="flex-1 flex gap-0.5">
          <div className="flex-1 bg-slate-500 rounded-sm" />
          <div className="flex-1 bg-slate-500 rounded-sm" />
        </div>
      </div>
    ),
  },
  {
    id: '3c', name: '3 columns', slots: 3,
    build: ([a, b, c]) => h(leaf(a), h(leaf(b), leaf(c))),
    thumb: (
      <div className="flex gap-0.5 w-full h-full">
        <div className="flex-1 bg-slate-500 rounded-sm" />
        <div className="flex-1 bg-slate-500 rounded-sm" />
        <div className="flex-1 bg-slate-500 rounded-sm" />
      </div>
    ),
  },
  {
    id: '4g', name: '2×2 grid', slots: 4,
    build: ([a, b, c, d]) => h(v(leaf(a), leaf(c)), v(leaf(b), leaf(d))),
    thumb: (
      <div className="grid grid-cols-2 gap-0.5 w-full h-full">
        <div className="bg-slate-500 rounded-sm" />
        <div className="bg-slate-500 rounded-sm" />
        <div className="bg-slate-500 rounded-sm" />
        <div className="bg-slate-500 rounded-sm" />
      </div>
    ),
  },
]

// ─── Tab slot picker ────────────────────────────────────────────────────────

function SlotPicker({ slotIndex, tabIds, tabs, onChange }: {
  slotIndex: number
  tabIds: string[]
  tabs: Tab[]
  onChange: (idx: number, tabId: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 w-12 flex-shrink-0">Slot {slotIndex + 1}</span>
      <select
        className="flex-1 bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-brand-500"
        value={tabIds[slotIndex] ?? ''}
        onChange={e => onChange(slotIndex, e.target.value)}
      >
        <option value="">— pick a tab —</option>
        {tabs.map(t => (
          <option key={t.id} value={t.id}>
            {t.label ?? (t.host && t.username ? `${t.username}@${t.host}` : 'New Connection')}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── Modal ──────────────────────────────────────────────────────────────────

interface Props {
  tabs: Tab[]
  onApply: (root: PaneNode) => void
  onClose: () => void
}

export default function LayoutPickerModal({ tabs, onApply, onClose }: Props) {
  const [selected, setSelected] = useState<Preset>(PRESETS[0])
  const [slotTabIds, setSlotTabIds] = useState<string[]>(() =>
    tabs.slice(0, PRESETS[0].slots).map(t => t.id)
  )

  // Resize slot assignments when preset changes
  useEffect(() => {
    setSlotTabIds(prev => {
      const next = Array.from({ length: selected.slots }, (_, i) => prev[i] ?? tabs[i]?.id ?? '')
      return next
    })
  }, [selected, tabs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const allFilled = slotTabIds.length === selected.slots && slotTabIds.every(Boolean)

  const handleApply = () => {
    if (!allFilled) return
    onApply(selected.build(slotTabIds))
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[520px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
          <h2 className="text-sm font-semibold text-slate-200">Split layout</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Preset grid */}
          <div className="grid grid-cols-3 gap-3">
            {PRESETS.map(preset => (
              <button
                key={preset.id}
                onClick={() => setSelected(preset)}
                className={clsx(
                  'flex flex-col gap-2 p-3 rounded-lg border transition-colors',
                  selected.id === preset.id
                    ? 'border-brand-500 bg-brand-500/10'
                    : 'border-surface-700 hover:border-surface-500 bg-surface-800'
                )}
              >
                <div className="w-full h-14">{preset.thumb}</div>
                <span className="text-xs text-slate-400 text-center">{preset.name}</span>
              </button>
            ))}
          </div>

          {/* Slot assignments */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-400">Assign tabs to slots</span>
            {Array.from({ length: selected.slots }, (_, i) => (
              <SlotPicker
                key={i}
                slotIndex={i}
                tabIds={slotTabIds}
                tabs={tabs}
                onChange={(idx, tabId) => setSlotTabIds(prev => {
                  const next = [...prev]
                  // If tabId already in another slot, swap
                  const clash = next.findIndex((id, j) => j !== idx && id === tabId)
                  if (clash >= 0) next[clash] = next[idx] ?? ''
                  next[idx] = tabId
                  return next
                })}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!allFilled}
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Apply layout
          </button>
        </div>
      </div>
    </div>
  )
}
