import clsx from 'clsx'
import { Check, Download, RotateCcw, Upload, X, XCircle } from 'lucide-react'
import type { TransferItem } from '@/store/sftpStore'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { progressTransition, surfaceSpring } from '@/motion/tokens'

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
}

export default function TransferQueue({ transfers, onDismiss, onRetry }: TransferQueueProps) {
  if (transfers.length === 0) return null

  return (
    <div
      className="pointer-events-none absolute bottom-4 right-4 z-40 flex max-h-[calc(100%-2rem)] w-[min(360px,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto"
    >
      <AnimatePresence initial={false}>
        {[...transfers].reverse().map(item => (
          <m.div
            key={item.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 14 }}
            transition={surfaceSpring}
            className="pointer-events-auto overflow-hidden rounded-lg border border-surface-700 bg-surface-900/95 shadow-xl backdrop-blur-sm"
            role={item.status === 'error' ? 'alert' : item.status === 'done' ? 'status' : undefined}
          >
            <div className="flex items-center gap-2 px-3 pt-2.5 text-xs">
              {item.direction === 'upload'
                ? <Upload className="h-3.5 w-3.5 flex-shrink-0 text-slate-500" />
                : <Download className="h-3.5 w-3.5 flex-shrink-0 text-slate-500" />}
              <span className="min-w-0 flex-1 truncate font-mono text-slate-200">{item.name}</span>
              {item.status === 'done' && <Check className="h-3.5 w-3.5 flex-shrink-0 text-brand-400" />}
              {item.status === 'error' && <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />}
              {item.status === 'error' && item.direction === 'upload' && (
                <button
                  type="button"
                  onClick={() => onRetry(item.id)}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label={`Dismiss ${item.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mx-3 mt-2 h-1 overflow-hidden bg-surface-800" role="progressbar" aria-label={`${item.name} transfer progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
              <m.div
                className={clsx('h-full', {
                  'animate-pulse bg-brand-500 motion-reduce:animate-none': item.status === 'active',
                  'bg-brand-500': item.status === 'done',
                  'bg-red-400': item.status === 'error',
                  'bg-slate-500': item.status === 'queued',
                })}
                style={{ width: `${item.progress}%` }}
                transition={progressTransition}
              />
            </div>
            <div className="mt-1 flex justify-between px-3 pb-2.5 font-mono text-[11px] text-slate-500">
              <span className="min-w-0 truncate">{item.error ?? `${formatBytes(item.bytes)} / ${formatBytes(item.total)}`}</span>
              <span className="ml-2 flex-shrink-0">{item.progress}%</span>
            </div>
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
