import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TabBar, { type TabBarActions } from './TabBar'
import { useTerminalStore } from '@/store/terminalStore'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useBroadcastStore } from '@/store/broadcastStore'

const logout = vi.hoisted(() => vi.fn())
vi.mock('@/utils/authRedirect', async importOriginal => ({
  ...(await importOriginal<typeof import('@/utils/authRedirect')>()),
  submitLdapLogout: logout,
}))

const tab = (id: string, overrides: Partial<import('@/types').Tab> = {}) => ({
  id,
  type: 'terminal' as const,
  host: 'host',
  port: 22,
  username: 'alice',
  label: null,
  status: 'connected' as const,
  sessionKey: `s:${id}`,
  ...overrides,
})

function actions(): TabBarActions {
  return {
    addTab: vi.fn(),
    closeTab: vi.fn(),
    cloneTab: vi.fn(),
    openSftpTab: vi.fn(),
    duplicateTab: vi.fn(),
    closeAllTabs: vi.fn(),
    openSettings: vi.fn(),
    openAdmin: vi.fn(),
    openSplitPicker: vi.fn(),
    openBroadcastPicker: vi.fn(),
    exitSplit: vi.fn(),
    toggleSidebar: vi.fn(),
    openCommandPalette: vi.fn(),
    setActiveTab: vi.fn(),
  }
}

beforeEach(() => {
  localStorage.clear()
  useSavedServerStore.setState({ servers: [] })
  useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
  useBroadcastStore.setState({ enabled: false, excludedTabIds: [], splitOwned: false })
  useTerminalStore.setState({ sessionId: 's', tabs: [], activeTabId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TabBar coverage', () => {
  it('renders every status, title, SFTP marker, and broadcast marker', () => {
    useTerminalStore.setState({
      tabs: [
        tab('disconnected', { status: 'disconnected', label: 'Disconnected' }),
        tab('connecting', { status: 'connecting', label: 'Connecting' }),
        tab('connected', { status: 'connected', label: null, port: 2222 }),
        tab('dead', { status: 'dead', label: 'Dead' }),
        tab('sftp', { type: 'sftp', label: 'Files' }),
        tab('plain', { host: null, username: null, label: null }),
        tab('portless', { label: 'Portless', port: null }),
      ],
      activeTabId: 'connected',
    })
    useBroadcastStore.setState({ enabled: true })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    expect(screen.getByTitle('alice@host (alice@host:2222)')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Disconnected/ })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tab', { name: /Connecting/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Dead/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /New Connection/ })).toHaveAttribute(
      'title',
      'New Connection tab',
    )
    expect(screen.getByTitle('Portless (alice@host)')).toBeInTheDocument()
  })

  it('uses every compact control and settings/logout/admin availability', () => {
    useTerminalStore.setState({ tabs: [tab('a'), tab('b')], activeTabId: 'a' })
    useServerConfigStore.setState({ ldapEnabled: true, isAdmin: true })
    const a = actions()
    const { rerender } = render(
      <TabBar actions={a} inSplitMode={false} compactSidebar sidebarOpen={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(a.toggleSidebar).toHaveBeenCalled()
    expect(a.openCommandPalette).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
    expect(logout).toHaveBeenCalled()
    expect(localStorage.getItem('torrus_session_id')).toBeNull()

    rerender(
      <TabBar actions={a} inSplitMode={true} compactSidebar sidebarOpen />,
    )
    expect(screen.getByRole('button', { name: 'Hide sessions' })).toBeInTheDocument()

    rerender(<TabBar actions={a} inSplitMode={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Admin console' }))
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }))
    expect(a.openAdmin).toHaveBeenCalled()
    expect(a.openSplitPicker).toHaveBeenCalled()
    expect(a.openSettings).toHaveBeenCalled()
    expect(a.closeAllTabs).toHaveBeenCalled()
  })

  it('toggles the split and broadcast controls', () => {
    useTerminalStore.setState({ tabs: [tab('a'), tab('b')], activeTabId: 'a' })
    useBroadcastStore.setState({ enabled: true })
    const a = actions()
    const { rerender } = render(<TabBar actions={a} inSplitMode />)
    fireEvent.click(screen.getByRole('button', { name: 'Exit split' }))
    expect(a.exitSplit).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Manage broadcast' }))
    expect(a.openBroadcastPicker).toHaveBeenCalled()

    useBroadcastStore.setState({ enabled: false })
    rerender(<TabBar actions={a} inSplitMode={false} />)
    expect(
      screen.getByRole('button', { name: 'Broadcast input to multiple terminals' }),
    ).toBeInTheDocument()
  })

  it('supports tab strip keys, reorder, context-menu keys, and tab switching', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    useTerminalStore.setState({
      tabs: [tab('a', { label: 'A' }), tab('b', { label: 'B' }), tab('c', { label: 'C' })],
      activeTabId: 'a',
    })
    const a = actions()
    render(<TabBar actions={a} inSplitMode={false} />)
    const strip = screen.getByRole('tablist')
    const first = screen.getByRole('tab', { name: /^A/ })
    const second = screen.getByRole('tab', { name: /^B/ })
    const third = screen.getByRole('tab', { name: /^C/ })
    first.focus()
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(a.setActiveTab).toHaveBeenCalledWith('b')
    fireEvent.keyDown(strip, { key: 'ArrowLeft' })
    expect(a.setActiveTab).toHaveBeenCalledWith('c')
    fireEvent.keyDown(strip, { key: 'x' })
    first.focus()
    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
    expect(useTerminalStore.getState().tabs.map(tab => tab.id)).toEqual(['b', 'a', 'c'])
    first.focus()
    fireEvent.keyDown(strip, { key: 'ArrowLeft', altKey: true })
    fireEvent.keyDown(second, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu', { name: 'Tab actions' })).toBeInTheDocument()

    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
    third.focus()
    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
    third.focus()
    fireEvent.keyDown(strip, { key: 'ContextMenu' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
  })

  it('reorders when no tab is focused and ignores missing active tabs', () => {
    useTerminalStore.setState({ tabs: [tab('a'), tab('b')], activeTabId: null })
    const a = actions()
    render(<TabBar actions={a} inSplitMode={false} />)
    const strip = screen.getByRole('tablist')
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(strip, { key: 'F10', shiftKey: true })
    fireEvent.keyDown(strip, { key: 'ContextMenu' })
    act(() => {
      useTerminalStore.setState({ activeTabId: 'missing' })
    })
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    fireEvent.keyDown(strip, { key: 'F10', shiftKey: true })
    useTerminalStore.setState({ activeTabId: 'a' })
    fireEvent.keyDown(strip, { key: 'ArrowRight', altKey: true })
  })

  it('opens a full context menu and invokes all actions', () => {
    useTerminalStore.setState({
      tabs: [
        tab('first', { label: 'First' }),
        tab('middle', { label: 'Middle', port: 2222 }),
        tab('last', { label: 'Last' }),
      ],
      activeTabId: 'middle',
    })
    const a = actions()
    render(<TabBar actions={a} inSplitMode={false} />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }), { clientX: 10, clientY: 20 })
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Move left' })).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Move right' }))
    expect(useTerminalStore.getState().tabs.map(tab => tab.id)).toEqual(['first', 'last', 'middle'])

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open SFTP' }))
    expect(a.openSftpTab).toHaveBeenCalledWith('middle')
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clone (same connection)' }))
    expect(a.cloneTab).toHaveBeenCalledWith('middle')
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate (new connection)' }))
    expect(a.duplicateTab).toHaveBeenCalledWith('middle')
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Middle/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const field = screen.getByRole('textbox', { name: 'Rename Middle' })
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'Renamed' } })
    fireEvent.keyDown(field, { key: 'ArrowLeft' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useTerminalStore.getState().tabs.find(tab => tab.id === 'middle')?.label).toBe('Renamed')
  })

  it('covers edit cancellation and blur confirmation', () => {
    useTerminalStore.setState({
      tabs: [tab('a', { label: 'A' }), tab('b', { label: 'B' })],
      activeTabId: 'a',
    })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    fireEvent.doubleClick(screen.getByRole('tab', { name: /^A/ }))
    const field = screen.getByRole('textbox', { name: 'Rename A' })
    fireEvent.change(field, { target: { value: 'Changed' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: /Rename/ })).not.toBeInTheDocument()

    fireEvent.doubleClick(screen.getByRole('tab', { name: /^A/ }))
    const second = screen.getByRole('textbox', { name: 'Rename A' })
    fireEvent.change(second, { target: { value: 'Blurred' } })
    fireEvent.blur(second, { relatedTarget: document.body })
    expect(useTerminalStore.getState().tabs[0].label).toBe('Blurred')

    fireEvent.doubleClick(screen.getByRole('tab', { name: /Blurred/ }))
    fireEvent.blur(screen.getByRole('textbox'), { relatedTarget: screen.getByRole('tab', { name: /B/ }) })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('saves a session, handles duplicate names, and closes the dialog', async () => {
    useTerminalStore.setState({
      tabs: [tab('a', { label: null, port: 2222 })],
      activeTabId: 'a',
    })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /alice@host/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to sessions' }))
    const dialog = screen.getByRole('dialog', { name: 'Save session' })
    const input = within(dialog).getByLabelText('Name')
    expect(input).toHaveValue('alice@host')
    expect(within(dialog).getByText('alice@host:2222')).toBeInTheDocument()

    useSavedServerStore.setState({
      servers: [{ id: 'saved', name: 'alice@host', host: 'host', port: 2222, username: 'alice' }],
    })
    fireEvent.submit(input.closest('form')!)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This session already exists.')
    fireEvent.change(input, { target: { value: 'Unique' } })
    useSavedServerStore.setState({ servers: [] })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save session' })).not.toBeInTheDocument())

    fireEvent.contextMenu(screen.getByRole('tab', { name: /alice@host/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to sessions' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('saves a port-22 tab with the default connection name', async () => {
    useTerminalStore.setState({
      tabs: [tab('a', { label: null, port: 22 })],
      activeTabId: 'a',
    })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /alice@host/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to sessions' }))
    const dialog = screen.getByRole('dialog', { name: 'Save session' })
    expect(within(dialog).getByText('alice@host')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '   ' } })
    fireEvent.submit(within(dialog).getByLabelText('Name').closest('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useSavedServerStore.getState().servers[0]).toMatchObject({
      name: 'alice@host',
      port: 22,
    })
  })

  it('defaults a missing tab port when saving', async () => {
    useTerminalStore.setState({
      tabs: [tab('a', { label: null, port: null })],
      activeTabId: 'a',
    })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /alice@host/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to sessions' }))
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useSavedServerStore.getState().servers[0].port).toBe(22)
  })

  it('closes the context menu on outside mousedown and restores focus on Escape', () => {
    useTerminalStore.setState({ tabs: [tab('a', { label: 'A' })], activeTabId: 'a' })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    const tabA = screen.getByRole('tab', { name: /^A/ })
    fireEvent.contextMenu(tabA)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(tabA)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(tabA)
  })

  it('clears a context menu whose tab disappeared and scrolls left or right', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    useTerminalStore.setState({ tabs: [tab('a', { label: 'A' }), tab('b', { label: 'B' })], activeTabId: 'a' })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    const list = screen.getByRole('tablist')
    const item = screen.getByRole('tab', { name: /^A/ }).parentElement!
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 100, 40))
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 50, 40))
    act(() => {
      useTerminalStore.setState({ activeTabId: 'b' })
    })
    vi.spyOn(screen.getByRole('tab', { name: /^B/ }).parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 50, 40))
    act(() => {
      useTerminalStore.setState({ activeTabId: 'a' })
    })
    expect(list.scrollLeft).toBe(-200)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /^A/ }))
    act(() => {
      useTerminalStore.setState({ tabs: [], activeTabId: null })
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    frame.mockRestore()
  })

  it('reorders through drag and ignores self-drops', () => {
    useTerminalStore.setState({
      tabs: [tab('a', { label: 'A' }), tab('b', { label: 'B' })],
      activeTabId: 'a',
    })
    render(<TabBar actions={actions()} inSplitMode={false} />)
    const a = screen.getByRole('tab', { name: /^A/ }).parentElement!
    const b = screen.getByRole('tab', { name: /^B/ }).parentElement!
    const data = { effectAllowed: '', dropEffect: '', setData: vi.fn() } as unknown as DataTransfer
    fireEvent.dragStart(a, { dataTransfer: data })
    fireEvent.dragOver(a, { dataTransfer: data })
    fireEvent.drop(a, { dataTransfer: data })
    fireEvent.dragStart(a, { dataTransfer: data })
    fireEvent.drop(b, { dataTransfer: data })
    fireEvent.dragEnd(a, { dataTransfer: data })
    expect(useTerminalStore.getState().tabs.map(tab => tab.id)).toEqual(['b', 'a'])
  })
})
