import { useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, ChevronUp, Download, RotateCcw, Upload, X, XCircle } from 'lucide-react'
import type { TransferItem } from '@/store/sftpStore'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; value >= 1024 && i < units.length; i++) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
}

interface TransferQueueProps {
  transfers: TransferItem[]
  onDismiss: (id: string) => void
  onRetry: (id: string) => void
  onClearCompleted: () => void
}

export default function TransferQueue({ transfers, onDismiss, onRetry, onClearCompleted }: TransferQueueProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (transfers.length === 0) {
    return null
  }
  const visibleTransfers = transfers.slice(-4)
  const activeCount = transfers.filter(item => item.status === 'active' || item.status === 'queued').length
  const completedCount = transfers.length - activeCount

  return (
    <div className="flex-shrink-0 border-t border-surface-800 bg-surface-950" aria-live="polite">
      <div className="flex h-8 items-center gap-2 border-b border-surface-900 px-2 text-xs">
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className="flex h-6 min-w-0 flex-1 items-center gap-2 text-left text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <span className="truncate">
            Transfers
            {activeCount > 0 ? ` (${activeCount} active)` : ''}
          </span>
        </button>
        {completedCount > 0 && (
          <button
            type="button"
            onClick={onClearCompleted}
            className="h-6 px-2 text-[11px] text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            title="Clear completed transfers"
          >
            Clear
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="max-h-28 overflow-y-auto">
          {visibleTransfers.map(item => (
            <div key={item.id} className="border-b border-surface-900 px-2 py-1.5">
              <div className="flex items-center gap-2 text-xs">
                {item.direction === 'upload'
                  ? <Upload className="h-3.5 w-3.5 text-slate-500" />
                  : <Download className="h-3.5 w-3.5 text-slate-500" />}
                <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{item.name}</span>
                {item.status === 'done' && <Check className="h-3.5 w-3.5 text-brand-400" />}
                {item.status === 'error' && <XCircle className="h-3.5 w-3.5 text-red-400" />}
                {item.status === 'error' && item.direction === 'upload' && (
                  <button
                    type="button"
                    onClick={() => onRetry(item.id)}
                    className="flex h-6 w-6 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    aria-label={`Retry ${item.name}`}
                    title="Retry upload"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
                {(item.status === 'done' || item.status === 'error') && (
                  <button
                    type="button"
                    onClick={() => onDismiss(item.id)}
                    className="flex h-6 w-6 items-center justify-center text-slate-600 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    aria-label={`Dismiss ${item.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1 h-1 bg-surface-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
                <div
                  className={clsx('h-full', {
                    'animate-pulse bg-brand-500': item.status === 'active',
                    'bg-brand-500': item.status === 'done',
                    'bg-red-400': item.status === 'error',
                    'bg-slate-500': item.status === 'queued',
                  })}
                  style={{ width: `${item.progress}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between font-mono text-xs text-slate-500">
                <span>{item.error ?? `${formatBytes(item.bytes)} / ${formatBytes(item.total)}`}</span>
                <span>{item.progress}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
