import clsx from 'clsx'
import { Check, Download, Upload, XCircle } from 'lucide-react'
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

export default function TransferQueue({ transfers }: { transfers: TransferItem[] }) {
  if (transfers.length === 0) {
    return null
  }
  return (
    <div className="max-h-40 overflow-y-auto border-t border-surface-800 bg-surface-950" aria-live="polite">
      {transfers.slice(-4).map(item => (
        <div key={item.id} className="px-2 py-1.5 border-b border-surface-900">
          <div className="flex items-center gap-2 text-xs">
            {item.direction === 'upload'
              ? <Upload className="h-3.5 w-3.5 text-slate-500" />
              : <Download className="h-3.5 w-3.5 text-slate-500" />}
            <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{item.name}</span>
            {item.status === 'done' && <Check className="h-3.5 w-3.5 text-brand-400" />}
            {item.status === 'error' && <XCircle className="h-3.5 w-3.5 text-red-400" />}
          </div>
          <div className="mt-1 h-1 bg-surface-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
            <div
              className={clsx('h-full', {
                'bg-brand-500 animate-pulse': item.status === 'active',
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
  )
}
