import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BroadcastPickerModal from './BroadcastPickerModal'
import { autoLayout } from '@/lib/autoLayout'
import type { Tab } from '@/types'

const tab = (id: string, overrides: Partial<Tab> = {}): Tab => ({
  id,
  type: 'terminal',
  host: 'host',
  port: 22,
  username: 'alice',
  label: null,
  status: 'connected',
  sessionKey: `s:${id}`,
  ...overrides,
})

function renderPicker(overrides: Partial<Parameters<typeof BroadcastPickerModal>[0]> = {}) {
  const props = {
    connectedTabs: [tab('a'), tab('b')],
    initialIncluded: new Set<string>(),
    broadcastEnabled: false,
    onApply: vi.fn(),
    onDisable: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const view = render(<BroadcastPickerModal {...props} />)
  return { ...props, ...view }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BroadcastPickerModal', () => {
  it('starts with every connected tab checked and toggles selection', () => {
    const { onApply } = renderPicker({
      connectedTabs: [
        tab('a', { label: 'Production' }),
        tab('b', { host: 'db', username: 'root' }),
        tab('c', { host: null, username: null }),
      ],
    })
    const checks = screen.getAllByRole('checkbox')
    expect(checks.every(check => (check as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('root@db')).toBeInTheDocument()
    expect(screen.getByText('Connection')).toBeInTheDocument()
    expect(screen.getByText('3 terminals selected — will auto-arrange in split view.')).toBeInTheDocument()

    fireEvent.click(checks[0])
    expect((checks[0] as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('2 terminals selected — will auto-arrange in split view.')).toBeInTheDocument()
    fireEvent.click(checks[0])
    fireEvent.click(screen.getByRole('button', { name: 'Start broadcast' }))
    expect(onApply).toHaveBeenCalledOnce()
    expect(onApply.mock.calls[0][0]).toEqual(['a', 'b', 'c'])
    expect(onApply.mock.calls[0][1]?.type).toBe('split')
  })

  it('uses the prior inclusion set and explains when fewer than two remain', () => {
    renderPicker({
      broadcastEnabled: true,
      initialIncluded: new Set(['b']),
    })
    expect(screen.getByText('Select at least 2 terminals to broadcast.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start broadcast' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disable broadcast' })).toBeInTheDocument()
  })

  it('does not preselect tabs when broadcast is enabled without an inclusion set', () => {
    renderPicker({ broadcastEnabled: true })
    expect(screen.getAllByRole('checkbox').every(check => (check as HTMLInputElement).checked)).toBe(true)
  })

  it('builds layouts for zero through five or more terminals', () => {
    for (const count of [0, 1, 2, 3, 4, 5, 6]) {
      const layout = autoLayout(Array.from({ length: count }, (_, index) => String(index)))
      expect(layout === null || layout.type === 'leaf' || layout.type === 'split').toBe(true)
      if (count === 0) expect(layout).toBeNull()
      if (count === 1) expect(layout).toEqual({ type: 'leaf', tabId: '0' })
      const { onApply, unmount } = renderPicker({
        connectedTabs: Array.from({ length: count }, (_, index) => tab(String(index))),
      })
      if (count >= 2) {
        fireEvent.click(screen.getByRole('button', { name: 'Start broadcast' }))
        const applied = onApply.mock.calls[0][1]
        expect(applied === null || applied.type === 'leaf' || applied.type === 'split').toBe(true)
      }
      unmount()
    }
  })

  it('closes from the header, footer, Escape, and disables broadcast', () => {
    const { onClose, onDisable } = renderPicker({
      broadcastEnabled: true,
      initialIncluded: new Set(['a', 'b']),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close broadcast picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable broadcast' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onDisable).toHaveBeenCalledOnce()
  })
})
