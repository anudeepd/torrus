import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TerminalSettings } from '@/types'

interface SettingsState extends TerminalSettings {
  update: (patch: Partial<TerminalSettings>) => void
  reset: () => void
}

const DEFAULTS: TerminalSettings = {
  scrollbackLines: 10_000,
  fontSize: 14,
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      update: (patch) => set((s) => ({ ...s, ...patch })),

      reset: () => set(DEFAULTS),
    }),
    {
      name: 'torrus-settings',
      version: 1,
    }
  )
)
