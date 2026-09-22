import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette'
import { useTerminalStore } from '@/store/terminalStore'

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props = {
    tabs: [],
    activeTabId: null,
    canSplit: false,
    canBroadcast: false,
    inSplitMode: false,
    onAddTab: vi.fn(),
    onSelectTab: vi.fn(),
    onOpenSftpTab: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSplitPicker: vi.fn(),
    onOpenBroadcastPicker: vi.fn(),
    onExitSplit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<CommandPalette {...props} />)
  return props
}

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup()
    useTerminalStore.setState({ tabs: [], activeTabId: null })
  })

  it('filters the command list as the query narrows', () => {
    renderPalette()

    expect(screen.getByRole('option', { name: /New terminal tab/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search commands and tabs'), { target: { value: 'settings' } })

    expect(screen.getByRole('option', { name: /Open settings/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /New terminal tab/ })).not.toBeInTheDocument()
  })

  it('runs the highlighted command on Enter and closes', () => {
    const props = renderPalette()

    fireEvent.change(screen.getByLabelText('Search commands and tabs'), { target: { value: 'settings' } })
    fireEvent.keyDown(screen.getByLabelText('Search commands and tabs'), { key: 'Enter' })

    expect(props.onOpenSettings).toHaveBeenCalledOnce()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('offers Open SFTP only while a connected terminal tab is active', () => {
    const { unmount } = render(<CommandPalette {...{
      tabs: [{ id: 't1', type: 'terminal' as const, host: 'db01', port: 22, username: 'root', label: null, status: 'connected' as const, sessionKey: 's:t1' }],
      activeTabId: 't1',
      canSplit: false, canBroadcast: false, inSplitMode: false,
      onAddTab: vi.fn(), onSelectTab: vi.fn(), onOpenSftpTab: vi.fn(), onOpenSettings: vi.fn(),
      onOpenSplitPicker: vi.fn(), onOpenBroadcastPicker: vi.fn(), onExitSplit: vi.fn(), onClose: vi.fn(),
    }} />)

    expect(screen.getByRole('option', { name: /Open SFTP for root@db01/ })).toBeInTheDocument()
    unmount()

    renderPalette({ tabs: [], activeTabId: null })
    expect(screen.queryByRole('option', { name: /Open SFTP/ })).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const props = renderPalette()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalledOnce()
  })
})
