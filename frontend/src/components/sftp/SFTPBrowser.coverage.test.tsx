/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import SFTPBrowser from './SFTPBrowser'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'
import type { SFTPEntry } from '@/types'

const hook = vi.hoisted(() => ({ state: {} as any }))
const collectDroppedEntries = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useSFTP', () => ({ useSFTP: () => hook.state }))
vi.mock('@/lib/drop-entries', () => ({ collectDroppedEntries }))

const tabId = 'sftp-tab'
const originalMatchMedia = window.matchMedia

const file = (name: string, overrides: Partial<SFTPEntry> = {}): SFTPEntry => ({
  name,
  path: `/var/log/${name}`,
  type: 'file',
  size: 12,
  mtime: 1_700_000_000,
  mode: 0o100644,
  owner: 'alice',
  group: 'staff',
  uid: 1000,
  gid: 1000,
  ...overrides,
})

const directory = (name: string, overrides: Partial<SFTPEntry> = {}): SFTPEntry => ({
  name,
  path: `/var/log/${name}`,
  type: 'directory',
  size: 0,
  mtime: 1_700_000_000,
  mode: 0o040755,
  owner: 'root',
  group: 'root',
  uid: 0,
  gid: 0,
  ...overrides,
})

function makeState(overrides: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    path: '/var/log',
    username: 'alice',
    isRoot: false,
    entries: [],
    loading: false,
    error: null,
    notice: null,
    disconnected: false,
    list: vi.fn(),
    open: vi.fn(),
    uploadFiles: vi.fn(async () => {}),
    retryUpload: vi.fn(),
    download: vi.fn(async () => {}),
    bulkDownload: vi.fn(async () => {}),
    remove: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
    chown: vi.fn(),
    loadAccounts: vi.fn(),
    users: [],
    groups: [],
    clearError: vi.fn(),
    clearNotice: vi.fn(),
    parentPath: (path: string) => path.split('/').slice(0, -1).join('/') || '/',
    ...overrides,
  }
  Object.defineProperty(state, 'selectedPaths', {
    configurable: true,
    get: () => useSFTPStore.getState().tabs[tabId]?.selectedPaths ?? [],
  })
  Object.defineProperty(state, 'transfers', {
    configurable: true,
    get: () => useSFTPStore.getState().transfers,
  })
  return state
}

function BrowserHarness({ socket }: { socket: Socket }) {
  useSFTPStore(s => s.tabs[tabId]?.selectedPaths)
  useSFTPStore(s => s.transfers)
  return <SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket} />
}

function renderBrowser(overrides: Record<string, unknown> = {}) {
  hook.state = makeState(overrides)
  const socket = createMockSocket()
  const view = render(<BrowserHarness socket={socket as unknown as Socket} />)
  const update = (patch: Record<string, unknown>) => {
    Object.assign(hook.state, patch)
    view.rerender(<BrowserHarness socket={socket as unknown as Socket} />)
  }
  return { socket, view, state: hook.state, update }
}

function menu() {
  return screen.getByRole('menu', { name: 'File actions' })
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  useSFTPStore.setState({ tabs: {}, transfers: [] })
  useTerminalStore.setState({
    sessionId: 'test-session',
    activeTabId: tabId,
    tabs: [{
      id: tabId,
      type: 'sftp',
      host: 'server.example',
      port: 22,
      username: 'alice',
      label: 'SFTP alice@server.example',
      status: 'connected',
      sessionKey: `test-session:${tabId}`,
      sourceTabId: 'terminal-tab',
    }],
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  collectDroppedEntries.mockReset()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: originalMatchMedia,
  })
})

describe('SFTPBrowser coverage', () => {
  it('covers the relative breadcrumb path, path editing, blur, enter, and escape', () => {
    const { state, update } = renderBrowser({ path: 'home/alice' })

    expect(screen.getByText('~')).toBeInTheDocument()
    expect(screen.getByText('home')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Edit path (Ctrl+L)'))
    const input = screen.getByRole('textbox', { name: 'Remote path' })
    fireEvent.blur(input)
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()

    state.list.mockClear()
    fireEvent.click(screen.getByTitle('Edit path (Ctrl+L)'))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Remote path' }), { key: 'Enter' })
    expect(state.list).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Edit path (Ctrl+L)'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote path' }), { target: { value: 'other/path' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Remote path' }), { key: 'Enter' })
    expect(state.list).toHaveBeenCalledWith('other/path')

    update({ path: '/var/log' })
    fireEvent.click(screen.getByTitle('Edit path (Ctrl+L)'))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Remote path' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
  })

  it('expands and collapses long breadcrumb trails and opens the editor from the rail', () => {
    renderBrowser({ path: '/a/b/c/d/e/f' })

    const hide = screen.getByRole('button', { name: 'Show 3 hidden path segments' })
    fireEvent.click(hide)
    expect(screen.getByRole('button', { name: 'Collapse path' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse path' }))

    let rail = screen.getByRole('button', { name: 'Edit remote path' })
    fireEvent.keyDown(rail, { key: 'Enter' })
    expect(screen.getByRole('textbox', { name: 'Remote path' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Remote path' }), { key: 'Escape' })

    rail = screen.getByRole('button', { name: 'Edit remote path' })
    fireEvent.keyDown(rail, { key: ' ' })
    expect(screen.getByRole('textbox', { name: 'Remote path' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Remote path' }), { key: 'Escape' })

    rail = screen.getByRole('button', { name: 'Edit remote path' })
    fireEvent.click(rail)
    expect(screen.getByRole('textbox', { name: 'Remote path' })).toBeInTheDocument()
  })

  it('sorts every column in both directions, composes rules, and resets them', () => {
    const entries = [
      file('bravo.log', { size: 20, owner: 'zoe', mode: 0o100600, mtime: 5 }),
      directory('alpha'),
      file('charlie.log', { size: 10, owner: 'amy', mode: 0o100644, mtime: 10 }),
    ]
    renderBrowser({ entries })

    const clickSort = (title: string) => fireEvent.click(screen.getByTitle(title))
    for (const title of ['Sort by name', 'Sort by size', 'Sort by owner', 'Sort by permissions', 'Sort by date']) {
      clickSort(title)
      clickSort(title)
    }
    expect(screen.getByRole('button', { name: 'Reset sort' })).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Sort by name'))
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset sort' }))
    expect(screen.queryByRole('button', { name: 'Reset sort' })).not.toBeInTheDocument()
  })

  it('refreshes quietly on activation and timers while the pane is visible and idle', () => {
    vi.useFakeTimers()
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => document.body,
    })
    try {
      const { state, update } = renderBrowser({ entries: [file('app.log')] })
      expect(state.list).toHaveBeenCalledWith(undefined, { quiet: true })

      act(() => vi.advanceTimersByTime(15_000))
      expect(state.list).toHaveBeenCalledTimes(2)

      fireEvent.dragOver(screen.getByRole('listbox', { name: 'File browser' }))
      update({})
      act(() => vi.advanceTimersByTime(15_000))
      expect(state.list).toHaveBeenCalledTimes(2)

      fireEvent.dragEnd(window)
      update({})
      act(() => vi.advanceTimersByTime(15_000))
      expect(state.list).toHaveBeenCalledTimes(3)
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
      else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
    }
  })

  it('skips background refresh while the page or pane is hidden and refreshes when visible', () => {
    vi.useFakeTimers()
    const hiddenPane = renderBrowser()
    hiddenPane.state.list.mockClear()
    act(() => vi.advanceTimersByTime(15_000))
    expect(hiddenPane.state.list).not.toHaveBeenCalled()
    hiddenPane.view.unmount()

    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => document.body,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      const { state } = renderBrowser()
      state.list.mockClear()
      act(() => vi.advanceTimersByTime(15_000))
      expect(state.list).not.toHaveBeenCalled()
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(screen.queryByText('Drop files to upload')).not.toBeInTheDocument()

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(state.list).toHaveBeenCalledWith(undefined, { quiet: true })
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
      else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
      if (visibility) Object.defineProperty(Document.prototype, 'visibilityState', visibility)
      else delete (Document.prototype as { visibilityState?: unknown }).visibilityState
      if (hidden) Object.defineProperty(Document.prototype, 'hidden', hidden)
      else delete (Document.prototype as { hidden?: unknown }).hidden
    }
  })

  it('clears drag timers on unmount and on a second drag over', () => {
    vi.useFakeTimers()
    const { view } = renderBrowser({ entries: [file('app.log')] })
    const browser = screen.getByRole('listbox', { name: 'File browser' })

    fireEvent.dragOver(browser)
    fireEvent.dragOver(browser)
    fireEvent.dragEnd(window)
    fireEvent.dragOver(browser)
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
    fireEvent.dragOver(browser)
    act(() => vi.advanceTimersByTime(1_500))
    act(() => vi.advanceTimersByTime(15_000))
    expect(screen.getByText("Upload hasn't started yet.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose files' }))
    fireEvent.dragOver(browser)
    view.unmount()
    act(() => vi.advanceTimersByTime(20_000))

    const second = renderBrowser({ entries: [file('app.log')] })
    fireEvent.dragOver(screen.getByRole('listbox', { name: 'File browser' }))
    act(() => vi.advanceTimersByTime(1_500))
    second.view.unmount()
    act(() => vi.advanceTimersByTime(20_000))
  })

  it('dismisses status notices and clears both error and success state', () => {
    const { state } = renderBrowser({ error: 'Listing failed.' })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(state.clearError).toHaveBeenCalledOnce()
    expect(state.clearNotice).toHaveBeenCalledOnce()
  })

  it('walks context-menu focus with arrows, home, end, and escape', async () => {
    const { state } = renderBrowser({ entries: [file('alpha.log'), file('bravo.log')] })
    const row = screen.getByRole('option', { name: /alpha\.log/ })
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })

    const items = within(menu()).getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    row.focus()
    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu(), { key: 'End' })
    expect(document.activeElement).toBe(items.at(-1))
    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu(), { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(menu(), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu(), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items.at(-1))
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'File actions' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(row))

    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })
    expect(screen.getByRole('menu', { name: 'File actions' })).toBeInTheDocument()
    fireEvent.pointerDown(window)
    expect(screen.queryByRole('menu', { name: 'File actions' })).not.toBeInTheDocument()
    expect(state.list).toHaveBeenCalled()
  })

  it('opens the more-actions and shortcut menus and performs their actions', async () => {
    const { state } = renderBrowser({ entries: [file('alpha.log')] })

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menu', { name: 'More actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))
    expect(state.list).toHaveBeenCalledWith('/var/log')
    expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }))
    expect(screen.getByRole('dialog', { name: 'New folder' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(await screen.findByText('Keyboard shortcuts', { selector: 'p' })).toBeInTheDocument()
    fireEvent.pointerDown(window)
    expect(screen.queryByText('Keyboard shortcuts', { selector: 'p' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Keyboard shortcuts', { selector: 'p' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.pointerDown(window)
    expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument()
  })

  it('uploads through the file input and reports blocked or incomplete drops', async () => {
    const { view, state } = renderBrowser({ entries: [file('alpha.log')] })
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!

    fireEvent.change(input, { target: { files: [new File(['data'], 'one.txt')] } })
    expect(state.uploadFiles).toHaveBeenCalledWith(expect.anything())

    const browser = screen.getByRole('listbox', { name: 'File browser' })
    collectDroppedEntries.mockResolvedValueOnce({ entries: [], skipped: 1 })
    fireEvent.drop(browser, { dataTransfer: { items: [], files: [] } })
    await waitFor(() => expect(useSFTPStore.getState().tabs[tabId]?.error).toContain('Could not read that folder'))

    collectDroppedEntries.mockResolvedValueOnce({ entries: [], skipped: 0 })
    fireEvent.drop(browser, { dataTransfer: { items: [], files: [] } })
    await waitFor(() => expect(useSFTPStore.getState().tabs[tabId]?.error).toContain('blocked by a browser extension'))

    const dropped = { file: new File(['data'], 'two.txt'), relativePath: 'two.txt' }
    collectDroppedEntries.mockResolvedValueOnce({ entries: [dropped], skipped: 0 })
    fireEvent.drop(browser, { dataTransfer: { items: [], files: [] } })
    await waitFor(() => expect(state.uploadFiles).toHaveBeenCalledWith([dropped]))
  })

  it('opens files and folders from the context menu and supports rename escape and commit', () => {
    const { state } = renderBrowser({
      path: '/home/alice',
      entries: [file('app.log', { path: '/home/alice/app.log' }), directory('archive', { path: '/home/alice/archive' })],
    })

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(state.download).toHaveBeenCalledWith(expect.objectContaining({ name: 'app.log' }))

    fireEvent.contextMenu(screen.getByRole('option', { name: /archive/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(state.list).toHaveBeenCalledWith('/home/alice/archive')

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename app.log' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Rename app.log' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /app\.log/ }))
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'File browser' }), { key: 'F2' })
    const rename = screen.getByRole('textbox', { name: 'Rename app.log' })
    fireEvent.change(rename, { target: { value: 'renamed.log' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(state.rename).toHaveBeenCalledWith('/home/alice/app.log', '/home/alice/renamed.log')
  })

  it('edits permissions with named and unknown owner/group entries', () => {
    const entry = file('app.log', { uid: 1000, gid: 2000, owner: undefined, group: undefined })
    const { state, update } = renderBrowser({ entries: [entry] })

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(state.loadAccounts).toHaveBeenCalledOnce()

    update({
      users: [{ uid: 1000, name: 'Alice' }],
      groups: [{ gid: 2000, name: 'Staff' }],
    })
    expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Staff' })).toBeInTheDocument()
    expect(screen.getByText(/Alice:Staff/)).toBeInTheDocument()

    update({
      users: [{ uid: 7, name: 'daemon' }],
      groups: [{ gid: 7, name: 'daemon' }],
    })
    expect(screen.getByRole('option', { name: '1000' })).toHaveAttribute('value', '1000')
    expect(screen.getByRole('option', { name: '2000' })).toHaveAttribute('value', '2000')

    update({
      users: [{ uid: 1000, name: 'alice' }],
      groups: [{ gid: 2000, name: 'staff' }],
    })
    expect(screen.getAllByRole('option', { name: 'alice' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'staff' })).toHaveLength(1)

    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Group' })).toBeInTheDocument()
  })

  it('validates ownership and renders the fallback dash for blank ownership', () => {
    renderBrowser({ entries: [file('app.log')] })
    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))

    const owner = screen.getByRole('spinbutton', { name: 'Owner UID' })
    const group = screen.getByRole('spinbutton', { name: 'Group GID' })
    fireEvent.change(owner, { target: { value: '' } })
    fireEvent.change(group, { target: { value: '1' } })
    expect(screen.getByText('Enter numeric UID and GID, or leave both blank.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.change(group, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('handles select-all, range deselection, keyboard navigation, and delete', () => {
    const entries = [
      file('alpha.log'),
      file('bravo.log'),
      file('charlie.log'),
      directory('delta'),
    ]
    const { state } = renderBrowser({ entries })
    const browser = screen.getByRole('listbox', { name: 'File browser' })
    const alpha = screen.getByRole('option', { name: /alpha\.log/ })
    const bravo = screen.getByRole('option', { name: /bravo\.log/ })
    const charlie = screen.getByRole('option', { name: /charlie\.log/ })

    fireEvent.click(alpha)
    fireEvent.click(charlie, { shiftKey: true })
    expect(screen.getByText('3 selected')).toBeInTheDocument()
    fireEvent.click(bravo, { shiftKey: true })
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }))
    expect(screen.getByText('4 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }))
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    fireEvent.keyDown(browser, { key: 'a', ctrlKey: true })
    expect(screen.getByText('4 selected')).toBeInTheDocument()
    fireEvent.keyDown(browser, { key: 'Escape' })
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    fireEvent.keyDown(browser, { key: 'ArrowDown' })
    expect(browser).toHaveAttribute('aria-activedescendant', expect.stringContaining('alpha.log'))
    fireEvent.keyDown(browser, { key: 'End' })
    expect(browser).toHaveAttribute('aria-activedescendant', expect.stringContaining('delta'))
    fireEvent.keyDown(browser, { key: 'Home' })
    fireEvent.keyDown(browser, { key: 'ArrowUp' })
    fireEvent.keyDown(browser, { key: ' ', shiftKey: true })
    fireEvent.keyDown(browser, { key: 'Enter' })
    expect(state.download.mock.calls.length + state.list.mock.calls.length).toBeGreaterThan(0)
    fireEvent.keyDown(browser, { key: 'Backspace' })
    expect(state.list).toHaveBeenCalledWith('/var')
    fireEvent.click(bravo)
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.keyDown(browser, { key: 'Delete' })
    expect(screen.getByRole('heading', { name: /Delete .+\?/ })).toBeInTheDocument()
  })

  it('toggles a row checkbox with shift and without modifiers', () => {
    const entries = [file('alpha.log'), file('bravo.log')]
    renderBrowser({ entries })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.log' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select bravo.log' }), { shiftKey: true })
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('deletes multiple sized files, creates folders with Enter, and reconnects', () => {
    const { state } = renderBrowser({
      entries: [file('alpha.log', { size: 1024 }), file('bravo.log', { size: 2048 })],
      disconnected: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect SSH session' }))
    expect(state.open).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'archive' } })
    fireEvent.keyDown(screen.getByLabelText('Folder name'), { key: 'Enter' })
    expect(state.mkdir).toHaveBeenCalledWith('archive')

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.keyDown(screen.getByLabelText('Folder name'), { key: 'Enter' })
    expect(state.mkdir).toHaveBeenCalledOnce()

    const alpha = screen.getByRole('option', { name: /alpha\.log/ })
    const bravo = screen.getByRole('option', { name: /bravo\.log/ })
    fireEvent.click(alpha)
    fireEvent.click(bravo, { ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'File browser' }), { key: 'Delete' })
    expect(screen.getByText(/totaling 3\.0 KB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(state.remove).toHaveBeenCalledWith(expect.arrayContaining(['/var/log/alpha.log', '/var/log/bravo.log']))
  })

  it('zips multiple files once while the overlay is present', async () => {
    let resolveBulk: (() => void) | undefined
    const bulkDownload = vi.fn(() => new Promise<void>(resolve => { resolveBulk = resolve }))
    renderBrowser({
      entries: [file('alpha.log'), file('bravo.log')],
      bulkDownload,
    })

    const selectAll = screen.getByRole('checkbox', { name: 'Select all files' })
    fireEvent.click(selectAll)
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download 2 as zip' }))
    expect(screen.getByText('Zipping 2 files…')).toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download 2 as zip' }))
    expect(bulkDownload).toHaveBeenCalledOnce()

    await act(async () => { resolveBulk?.() })
    expect(screen.queryByText('Zipping 2 files…')).not.toBeInTheDocument()
  })

  it('removes completed transfer entries after their retention window', () => {
    vi.useFakeTimers()
    useSFTPStore.setState({
      transfers: [{
        id: 'done-1',
        tabId,
        name: 'done.txt',
        direction: 'upload',
        status: 'done',
        progress: 100,
        bytes: 10,
        total: 10,
        startedAt: Date.now(),
      }],
    })
    const removeTransfer = vi.spyOn(useSFTPStore.getState(), 'removeTransfer')
    const { view } = renderBrowser()

    act(() => vi.advanceTimersByTime(5_000))
    expect(removeTransfer).toHaveBeenCalledWith('done-1')

    useSFTPStore.setState({
      transfers: [{
        id: 'done-2',
        tabId,
        name: 'done-2.txt',
        direction: 'upload',
        status: 'done',
        progress: 100,
        bytes: 10,
        total: 10,
        startedAt: Date.now(),
      }],
    })
    view.rerender(
      <SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={createMockSocket() as unknown as Socket} />,
    )
    act(() => {
      useSFTPStore.setState({ transfers: [] })
      view.rerender(
        <SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={createMockSocket() as unknown as Socket} />,
      )
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(removeTransfer).not.toHaveBeenCalledWith('done-2')
    view.unmount()
  })

  it('renders loading, empty, success, and context vibration states', () => {
    const vibrate = vi.fn()
    const matchMedia = vi.fn(() => ({ matches: true }))
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate })

    const { update } = renderBrowser({ loading: true, entries: [] })
    update({ loading: false, entries: [] })
    expect(screen.getByText('This folder is empty.')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'File browser' }), { key: 'a', ctrlKey: true })

    update({ entries: [file('alpha.log')] })
    expect(screen.getByTitle('Connected as alice')).toBeInTheDocument()
    update({ notice: { tone: 'success', message: 'Done.' } })
    expect(screen.getByRole('status')).toHaveTextContent('Done.')

    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    expect(vibrate).toHaveBeenCalledWith(10)

    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined })
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
  })

  it('formats sparse metadata and toggles every permission control', () => {
    const sparse = { name: 'sparse', path: '/var/log/sparse', type: 'file' as const, size: 0, mtime: 0 }
    const uidOnly = {
      ...sparse,
      name: 'uid-only',
      path: '/var/log/uid-only',
      owner: undefined,
      uid: 5,
      mode: 0o104644,
    }
    const groupOnly = {
      ...sparse,
      name: 'group-only',
      path: '/var/log/group-only',
      owner: undefined,
      uid: undefined,
      group: undefined,
      gid: undefined,
      mode: 0o102000,
    }
    const special = {
      ...sparse,
      name: 'special',
      path: '/var/log/special',
      mode: 0o101001,
    }
    const { state } = renderBrowser({ entries: [sparse, uidOnly, groupOnly, special, { ...sparse, name: 'sparse' }] })

    expect(screen.getByRole('option', { name: /uid-only.*owner 5/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /group-only.*owner -/ })).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Sort by owner'))
    fireEvent.click(screen.getByTitle('Sort by permissions'))
    fireEvent.click(screen.getByTitle('Sort by date'))

    fireEvent.contextMenu(screen.getByRole('option', { name: /special/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    const octal = screen.getByRole('textbox', { name: 'Octal mode' })
    fireEvent.change(octal, { target: { value: '' } })
    expect(screen.getByText('Enter three or four octal digits (000–7777).')).toBeInTheDocument()
    fireEvent.change(octal, { target: { value: '777' } })
    expect(octal).toHaveValue('777')
    fireEvent.change(octal, { target: { value: '999' } })
    expect(octal).toHaveValue('777')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Setuid' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Setgid' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sticky' }))
    for (const label of ['Owner Execute', 'Group Execute', 'Other Execute']) {
      fireEvent.click(screen.getByRole('checkbox', { name: label }))
      fireEvent.click(screen.getByRole('checkbox', { name: label }))
    }
    expect(octal).toHaveValue('7777')

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(state.chmod).toHaveBeenCalledWith('/var/log/special', 0o7777)
  })

  it('guards Ctrl+L while a dialog is open', async () => {
    renderBrowser({ entries: [file('alpha.log')] })
    const browser = screen.getByRole('listbox', { name: 'File browser' })
    browser.focus()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
    outside.remove()
    browser.focus()

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    await screen.findByRole('dialog', { name: 'New folder' })
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(browser)
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('resets rename when the new name is blank', () => {
    renderBrowser({ entries: [file('alpha.log')] })
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const rename = screen.getByRole('textbox', { name: 'Rename alpha.log' })
    fireEvent.change(rename, { target: { value: '   ' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: 'Rename alpha.log' })).not.toBeInTheDocument()
  })

  it('closes the more-actions menu with Escape and uses plain space selection', () => {
    renderBrowser({ entries: [file('alpha.log')] })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument()

    const browser = screen.getByRole('listbox', { name: 'File browser' })
    fireEvent.click(screen.getByRole('option', { name: /alpha\.log/ }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.keyDown(browser, { key: ' ' })
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('shows root identity and clears selection from blank browser space', () => {
    renderBrowser({ isRoot: true, entries: [file('alpha.log')] })
    expect(screen.getByText('ROOT')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /alpha\.log/ }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('listbox', { name: 'File browser' }))
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('renders the loading overlay when refreshing a populated folder', () => {
    const { update } = renderBrowser({ entries: [file('alpha.log')] })
    update({ loading: true })
    expect(screen.getByText('Loading folder…')).toBeInTheDocument()
  })

  it('opens permissions for multiple entries and a directory-only delete without a size', () => {
    const { state } = renderBrowser({
      entries: [directory('alpha'), directory('bravo')],
    })
    fireEvent.click(screen.getByRole('option', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('option', { name: /bravo/ }), { ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'File browser' }), { key: 'Delete' })
    expect(screen.getByText('Permanently remove 2 items from the remote server.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(screen.getByText('2 selected items')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Owner Execute' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Owner Execute' }))
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(state.chmod).toHaveBeenCalledTimes(2)
  })

  it('handles shift-click ranges with an empty anchor and shift+arrow navigation', () => {
    const entries = [file('alpha.log'), file('bravo.log'), file('charlie.log')]
    renderBrowser({ entries })
    const browser = screen.getByRole('listbox', { name: 'File browser' })

    fireEvent.click(screen.getByRole('option', { name: /bravo\.log/ }), { shiftKey: true })
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    fireEvent.keyDown(browser, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByText(/selected/)).toBeInTheDocument()
  })

  it('renders home and root breadcrumbs and renames at the home path', () => {
    const { update } = renderBrowser({
      path: '.',
      entries: [file('alpha.log', { path: 'alpha.log' })],
    })
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename alpha.log' }), { target: { value: 'beta.log' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename alpha.log' }), { key: 'Enter' })
    expect(hook.state.rename).toHaveBeenCalledWith('alpha.log', 'beta.log')

    update({ path: '/' })
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument()
  })

  it('downloads a single file from the context menu', () => {
    const { state } = renderBrowser({ entries: [file('alpha.log')] })
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
    expect(state.download).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha.log' }))
  })

  it('auto-dismisses error notices after twelve seconds', () => {
    vi.useFakeTimers()
    const { state } = renderBrowser({
      notice: { tone: 'error', message: 'Upload failed.' },
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(state.clearNotice).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(7_000))
    expect(state.clearNotice).toHaveBeenCalledOnce()
  })

  it('does not schedule a second removal timer for an already tracked transfer', () => {
    vi.useFakeTimers()
    const transfer = {
      id: 'done-1',
      tabId,
      name: 'done.txt',
      direction: 'upload' as const,
      status: 'done' as const,
      progress: 100,
      bytes: 10,
      total: 10,
      startedAt: Date.now(),
    }
    useSFTPStore.setState({ transfers: [transfer] })
    const removeTransfer = vi.spyOn(useSFTPStore.getState(), 'removeTransfer')
    const { view } = renderBrowser()
    useSFTPStore.setState({ transfers: [{ ...transfer }] })
    view.rerender(<BrowserHarness socket={createMockSocket() as unknown as Socket} />)
    act(() => vi.advanceTimersByTime(5_000))
    expect(removeTransfer).toHaveBeenCalledWith('done-1')
  })

  it('ignores Ctrl+L with other modifiers and while permissions or delete are open', async () => {
    const { state } = renderBrowser({ entries: [file('alpha.log')] })
    const browser = screen.getByRole('listbox', { name: 'File browser' })
    browser.focus()

    for (const event of [
      { key: 'l', ctrlKey: true, metaKey: true },
      { key: 'l', ctrlKey: true, altKey: true },
      { key: 'l', ctrlKey: true, shiftKey: true },
    ]) {
      fireEvent.keyDown(window, event)
      expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
    }

    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    await screen.findByRole('heading', { name: 'Permissions' })
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(browser)
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.keyDown(browser, { key: 'ArrowDown' })
    fireEvent.keyDown(browser, { key: 'Delete' })
    await screen.findByRole('alertdialog', { name: 'Delete item?' })
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(browser)
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(screen.queryByRole('textbox', { name: 'Remote path' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(state.list).toHaveBeenCalled()
  })

  it('opens permissions for an entry with unknown mode and ownership', () => {
    const sparse = { name: 'sparse', path: '/var/log/sparse', type: 'file' as const, size: 0, mtime: 0 }
    const { state } = renderBrowser({ entries: [sparse] })
    fireEvent.contextMenu(screen.getByRole('option', { name: /sparse/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(screen.getByRole('textbox', { name: 'Octal mode' })).toHaveValue('000')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(state.loadAccounts).toHaveBeenCalled()
  })

  it('applies ownership changes through the numeric inputs', () => {
    const { state } = renderBrowser({ entries: [file('alpha.log')] })
    fireEvent.contextMenu(screen.getByRole('option', { name: /alpha\.log/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Owner UID' }), { target: { value: '2000' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Group GID' }), { target: { value: '2001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(state.chown).toHaveBeenCalledWith('/var/log/alpha.log', 2000, 2001)
  })

  it('selects all and sorts entries with missing dates', () => {
    const entries = [
      file('alpha.log', { mtime: undefined as unknown as number }),
      file('bravo.log', { mtime: 5 }),
    ]
    renderBrowser({ entries })
    fireEvent.click(screen.getByTitle('Sort by date'))
    expect(screen.getByRole('option', { name: /alpha\.log/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'File browser' }), { key: 'a', ctrlKey: true })
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })
})
