import Dialog from '@/components/ui/Dialog'
import { Settings, RotateCcw } from 'lucide-react'
import { useSettingsStore } from '@/store/settingsStore'

interface SettingsDialogProps {
  onClose: () => void
}


const SCROLLBACK_OPTIONS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000]
const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16, 18, 20]

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const scrollbackLines = useSettingsStore(s => s.scrollbackLines)
  const fontSize = useSettingsStore(s => s.fontSize)
  const update = useSettingsStore(s => s.update)
  const reset = useSettingsStore(s => s.reset)

  return (
    <Dialog label="Terminal Settings" onClose={onClose} className="w-80 gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-slate-200">Terminal Settings</h2>
          </div>
          <button
            onClick={reset}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
            title="Reset to defaults"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {/* Scrollback buffer */}
          <div className="flex flex-col gap-1">
            <label htmlFor="settings-scrollback" className="text-sm text-slate-200">Scrollback lines</label>
            <p id="settings-scrollback-help" className="text-xs text-slate-400">Number of lines kept in terminal history</p>
            <select
              id="settings-scrollback"
              aria-describedby="settings-scrollback-help"
              value={scrollbackLines}
              onChange={e => update({ scrollbackLines: parseInt(e.target.value, 10) })}
              className="mt-1 w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-500 transition-colors"
            >
              {SCROLLBACK_OPTIONS.map(n => (
                <option key={n} value={n}>{n.toLocaleString()}</option>
              ))}
            </select>
          </div>

          {/* Font size */}
          <div className="flex flex-col gap-1">
            <label htmlFor="settings-font-size" className="text-sm text-slate-200">Font size</label>
            <p id="settings-font-size-help" className="text-xs text-slate-400">Terminal font size in pixels</p>
            <select
              id="settings-font-size"
              aria-describedby="settings-font-size-help"
              value={fontSize}
              onChange={e => update({ fontSize: parseInt(e.target.value, 10) })}
              className="mt-1 w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-500 transition-colors"
            >
              {FONT_SIZE_OPTIONS.map(n => (
                <option key={n} value={n}>{n}px</option>
              ))}
            </select>
          </div>

        </div>

        <button
          onClick={onClose}
          className="w-full px-3 py-2 rounded-md text-sm text-slate-400 bg-surface-800 hover:bg-surface-700 hover:text-slate-200 transition-colors"
        >
          Close
        </button>
    </Dialog>
  )
}
