import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TabBar, { type TabBarActions } from './TabBar'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useTerminalStore } from '@/store/terminalStore'

const noopActions: TabBarActions = {
  addTab: () => {},
  closeTab: () => {},
  cloneTab: () => {},
  openSftpTab: () => {},
  duplicateTab: () => {},
  closeAllTabs: () => {},
  openSettings: () => {},
  openAdmin: () => {},
  openSplitPicker: () => {},
  openBroadcastPicker: () => {},
  exitSplit: () => {},
  toggleSidebar: () => {},
  openCommandPalette: () => {},
  setActiveTab: () => {},
}

describe('TabBar', () => {

  afterEach(() => {
    cleanup()
    useTerminalStore.setState({ tabs: [], activeTabId: null })
    useBroadcastStore.setState({ enabled: false, excludedTabIds: [] })
    useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
  })

  it('prevents the right-button press from selecting tab text', () => {
    useTerminalStore.setState({
      tabs: [{
        id: 'tab-1',
        type: 'terminal',
        host: null,
        port: null,
        username: null,
        label: 'Production',
        status: 'disconnected',
        sessionKey: 'session-1:tab-1',
      }],
      activeTabId: 'tab-1',
    })

    render(
      <TabBar
        actions={noopActions}
        inSplitMode={false}
      />,
    )

    const tab = screen.getByRole('tab', { name: /production/i })
    expect(tab.parentElement).toHaveClass('select-none')
    expect(fireEvent.mouseDown(tab, { button: 2 })).toBe(false)
  })
  it('reorders the focused tab from the keyboard, without dragging', () => {
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'One', status: 'disconnected', sessionKey: 'session-1:tab-1' },
        { id: 'tab-2', type: 'terminal', host: null, port: null, username: null, label: 'Two', status: 'disconnected', sessionKey: 'session-1:tab-2' },
        { id: 'tab-3', type: 'terminal', host: null, port: null, username: null, label: 'Three', status: 'disconnected', sessionKey: 'session-1:tab-3' },
      ],
      activeTabId: 'tab-1',
    })

    render(
      <TabBar
        actions={noopActions}
        inSplitMode={false}
      />,
    )

    const tablist = screen.getByRole('tablist')
    const tabIds = () => useTerminalStore.getState().tabs.map(tab => tab.id)

    screen.getByRole('tab', { name: /one/i }).focus()
    fireEvent.keyDown(tablist, { key: 'ArrowRight', altKey: true })
    expect(tabIds()).toEqual(['tab-2', 'tab-1', 'tab-3'])

    // Moving left again returns it, and the ends do not wrap.
    fireEvent.keyDown(tablist, { key: 'ArrowLeft', altKey: true })
    expect(tabIds()).toEqual(['tab-1', 'tab-2', 'tab-3'])
    fireEvent.keyDown(tablist, { key: 'ArrowLeft', altKey: true })
    expect(tabIds()).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })

  it('scrolls a clipped active tab, including its close button, fully into view', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'Production 1', status: 'disconnected', sessionKey: 'session-1:tab-1' },
        { id: 'tab-2', type: 'terminal', host: null, port: null, username: null, label: 'Production 2', status: 'disconnected', sessionKey: 'session-1:tab-2' },
      ],
      activeTabId: 'tab-1',
    })

    render(
      <TabBar
        actions={{ ...noopActions, setActiveTab: id => useTerminalStore.getState().setActiveTab(id) }}
        inSplitMode={false}
      />,
    )

    const tabList = screen.getByRole('tablist')
    const tab = screen.getByRole('tab', { name: /production 2/i })
    const item = tab.parentElement!
    vi.spyOn(tabList, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 0, 100, 40))
    tabList.scrollLeft = 20

    act(() => fireEvent.click(tab))

    expect(tabList.scrollLeft).toBe(80)
    frame.mockRestore()
  })
  it('leaves the arrow keys to the rename field inside the tab strip', () => {
    const setActiveTab = vi.fn()
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'First', status: 'disconnected', sessionKey: 'session-1:tab-1' },
        { id: 'tab-2', type: 'terminal', host: null, port: null, username: null, label: 'Second', status: 'disconnected', sessionKey: 'session-1:tab-2' },
      ],
      activeTabId: 'tab-1',
    })

    render(<TabBar actions={{ ...noopActions, setActiveTab }} inSplitMode={false} />)

    // Double-click opens the inline rename field; the strip must not steal the
    // arrow keys that move its caret, and must not cancel the edit.
    fireEvent.doubleClick(screen.getByRole('tab', { name: /first/i }))
    const field = screen.getByDisplayValue('First')
    fireEvent.keyDown(field, { key: 'ArrowRight' })

    expect(setActiveTab).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('First')).toBe(field)
  })

  it('returns focus to the tab when its context menu is dismissed with Escape', () => {
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'Only', status: 'disconnected', sessionKey: 'session-1:tab-1' },
      ],
      activeTabId: 'tab-1',
    })

    render(<TabBar actions={noopActions} inSplitMode={false} />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /only/i }))
    expect(screen.getByRole('menu')).toBeTruthy()

    // The dismiss layer consumes Escape on window capture, so the restore has
    // to live in its callback rather than the menu's own keydown handler.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /only/i }))
  })
  it('activates a tab through the shell handler, not the store directly', () => {
    // The shell's handler leaves a broadcast-owned split; calling the store
    // setter here skipped that teardown.
    const setActiveTab = vi.fn()
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'A', status: 'disconnected', sessionKey: 'session-1:tab-1' },
        { id: 'tab-2', type: 'terminal', host: null, port: null, username: null, label: 'B', status: 'disconnected', sessionKey: 'session-1:tab-2' },
      ],
      activeTabId: 'tab-1',
    })

    render(<TabBar actions={{ ...noopActions, setActiveTab }} inSplitMode={false} />)

    fireEvent.click(screen.getByRole('tab', { name: /^b$/i }))

    expect(setActiveTab).toHaveBeenCalledWith('tab-2')
    expect(useTerminalStore.getState().activeTabId).toBe('tab-1')
  })
  it('shows the admin console button only to admin users', () => {
    const props = {
      actions: noopActions,
      inSplitMode: false,
    }

    useServerConfigStore.setState({ ldapEnabled: true, isAdmin: false })
    const { unmount } = render(<TabBar {...props} />)
    expect(screen.queryByRole('button', { name: 'Admin console' })).not.toBeInTheDocument()

    unmount()
    useServerConfigStore.setState({ ldapEnabled: true, isAdmin: true })
    render(<TabBar {...props} />)
    expect(screen.getByRole('button', { name: 'Admin console' })).toBeInTheDocument()
  })
  it('shows the command palette button only in compact layout', () => {
    const onOpenCommandPalette = vi.fn()
    const props = {
      actions: { ...noopActions, openCommandPalette: onOpenCommandPalette },
      inSplitMode: false,
    }

    const { unmount } = render(<TabBar {...props} />)
    expect(screen.queryByRole('button', { name: 'Open command palette' })).not.toBeInTheDocument()

    unmount()
    render(<TabBar {...props} compactSidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(onOpenCommandPalette).toHaveBeenCalledOnce()
  })

  it('reorders tabs when one is dragged onto another', () => {
    const mkTab = (id: string, label: string) => ({
      id, type: 'terminal' as const, host: null, port: null, username: null,
      label, status: 'disconnected' as const, sessionKey: `session-1:${id}`,
    })
    useTerminalStore.setState({
      tabs: [mkTab('tab-1', 'Production'), mkTab('tab-2', 'Staging'), mkTab('tab-3', 'Dev')],
      activeTabId: 'tab-1',
    })

    render(
      <TabBar
        actions={noopActions}
        inSplitMode={false}
      />,
    )

    const production = screen.getByRole('tab', { name: /production/i }).parentElement!
    const dev = screen.getByRole('tab', { name: /dev/i }).parentElement!
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() } as unknown as DataTransfer
    fireEvent.dragStart(production, { dataTransfer })
    fireEvent.dragOver(dev, { dataTransfer })
    fireEvent.drop(dev, { dataTransfer })
    fireEvent.dragEnd(production, { dataTransfer })

    expect(useTerminalStore.getState().tabs.map(t => t.label)).toEqual(['Staging', 'Dev', 'Production'])
  })
})

