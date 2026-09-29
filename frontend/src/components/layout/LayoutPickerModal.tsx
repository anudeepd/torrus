import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import Dialog from '@/components/ui/Dialog'
import type { PaneNode } from '@/store/layoutStore'
import { makeSplitId } from '@/store/layoutStore'
import type { Tab } from '@/types'
import * as m from 'motion/react-m'
import { AnimatePresence } from 'motion/react'
import { microTransition, surfaceSpring } from '@/motion/tokens'

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
      <label htmlFor={`slot-${slotIndex}`} className="text-xs font-medium text-slate-400 w-12 flex-shrink-0">Slot {slotIndex + 1}</label>
      <select
        id={`slot-${slotIndex}`}
        name={`slot-${slotIndex + 1}`}
        className="flex-1 bg-surface-900 border border-surface-700 rounded-md px-2 py-1 text-xs text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus:border-brand-500"
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

  // The row count follows the preset while the picks stay user state, so the
  // rendered list is derived here rather than reconciled in an effect.
  const slotIds = Array.from({ length: selected.slots }, (_, i) => slotTabIds[i] ?? tabs[i]?.id ?? '')

  const allFilled = slotIds.length === selected.slots && slotIds.every(Boolean)

  const handleApply = () => {
    if (!allFilled) return
    onApply(selected.build(slotIds))
  }

  return (
    <Dialog label="Split layout" onClose={onClose} className="max-w-[520px] p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
          <h2 className="text-sm font-semibold text-slate-200 text-balance">Split layout</h2>
          <button type="button" onClick={onClose} aria-label="Close split layout picker" className="rounded-md text-slate-400 hover:text-slate-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Preset grid */}
          <div className="grid grid-cols-3 gap-3">
            {PRESETS.map(preset => (
              <m.button
                key={preset.id}
                onClick={() => setSelected(preset)}
                whileTap={{ scale: 0.97 }}
                layout
                className={cn(
                  'relative flex flex-col gap-2 p-3 rounded-lg border transition-colors',
                  selected.id === preset.id
                    ? 'border-brand-500 bg-brand-500/10'
                    : 'border-surface-700 hover:border-surface-500 bg-surface-800'
                )}
              >
                {selected.id === preset.id && (
                  <m.span
                    layoutId="selected-layout-preset"
                    className="pointer-events-none absolute -inset-px rounded-lg border-2 border-brand-400/70"
                    transition={surfaceSpring}
                  />
                )}
                <div className="w-full h-14">{preset.thumb}</div>
                <span className="text-xs text-slate-400 text-center">{preset.name}</span>
              </m.button>
            ))}
          </div>

          {/* Slot assignments */}
          <m.div layout transition={microTransition} className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-400">Assign tabs to slots</span>
            <AnimatePresence initial={false} mode="popLayout">
              {Array.from({ length: selected.slots }, (_, i) => (
                <m.div
                  key={`slot-${i}`}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={microTransition}
                  className="overflow-hidden"
                >
                  <SlotPicker
                    slotIndex={i}
                    tabIds={slotIds}
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
                </m.div>
              ))}
            </AnimatePresence>
          </m.div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!allFilled}
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white bg-brand-700 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Apply layout
          </button>
        </div>
    </Dialog>
  )
}
