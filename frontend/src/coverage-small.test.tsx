import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Component } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileArchive, FileImage, FileText, Folder } from 'lucide-react'

import FileIcon from '@/components/sftp/FileIcon'
import TransferQueue from '@/components/sftp/TransferQueue'
import Input from '@/components/ui/Input'
import CommandPalette from '@/components/ui/CommandPalette'
import { PaneErrorBoundary, PaneErrorFallback } from '@/components/ui/PaneErrorBoundary'
import { useModalFocus } from '@/hooks/useModalFocus'
import { formatBytes, formatSpeed } from '@/lib/format'
import { useDismissLayer } from '@/lib/dismissLayers'
import { handleMenuKeyDown } from '@/lib/menuKeys'
import { browserDrawsRevealButton } from '@/lib/revealButton'
import { tabBaseName, tabDisplayName } from '@/lib/tabName'
import { getLayoutTabIds, makeSplitId, useLayoutStore, type PaneNode } from '@/store/layoutStore'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useTerminalStore } from '@/store/terminalStore'
import { useSFTPStore } from '@/store/sftpStore'
import type { SFTPEntry, Tab } from '@/types'

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

const entry = (name: string, type: SFTPEntry['type'] = 'file') => ({
  name,
  path: `/${name}`,
  type,
  size: 1,
  mtime: 1,
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('format and tab names', () => {
  it('formats every byte unit boundary', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(1024 ** 6)).toMatch(/PB$/)
    expect(formatSpeed(1024)).toBe('1.0 KB/s')
  })

  it('uses labels, connection names, and SFTP fallbacks', () => {
    expect(tabBaseName(tab('a', { label: 'Production' }))).toBe('Production')
    expect(tabBaseName(tab('a', { type: 'sftp' }))).toBe('SFTP alice@host')
    expect(tabBaseName(tab('a', { type: 'sftp', host: null, username: null }))).toBe('SFTP')
    expect(tabBaseName(tab('a', { host: null, username: null }))).toBe('New Connection')
  })

  it('numbers duplicate names only when there is a duplicate', () => {
    const first = tab('a', { label: 'Same' })
    const second = tab('b', { label: 'Same' })
    expect(tabDisplayName(first, [first])).toBe('Same')
    expect(tabDisplayName(first, [first, second])).toBe('Same (1)')
    expect(tabDisplayName(second, [first, second])).toBe('Same (2)')
  })
})

describe('shared keyboard helpers', () => {
  it('handles all menu keys and empty menus', () => {
    const close = vi.fn()
    handleMenuKeyDown({} as never, null, close)

    const menu = document.createElement('div')
    const first = document.createElement('button')
    const second = document.createElement('button')
    first.setAttribute('role', 'menuitem')
    second.setAttribute('role', 'menuitem')
    menu.append(first, second)
    document.body.append(menu)

    first.focus()
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      handleMenuKeyDown(
        event as unknown as React.KeyboardEvent<HTMLElement>,
        menu,
        close,
      )
      return event
    }
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(second)
    press('ArrowDown')
    expect(document.activeElement).toBe(first)
    press('ArrowUp')
    expect(document.activeElement).toBe(second)
    press('Home')
    expect(document.activeElement).toBe(first)
    press('End')
    expect(document.activeElement).toBe(second)
    const escape = press('Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    press('Tab')
  })

  it('installs one Escape listener and dismisses only the top layer', () => {
    const first = vi.fn()
    const second = vi.fn()
    function One() {
      useDismissLayer(true, first)
      return null
    }
    function Two() {
      useDismissLayer(true, second)
      return null
    }
    const { rerender } = render(<One />)
    rerender(
      <>
        <One />
        <Two />
      </>,
    )

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    })
    expect(second).toHaveBeenCalledOnce()
    rerender(<One />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('focuses the first control, wraps Tab, and restores the opener', async () => {
    document.body.innerHTML = '<button id="opener">open</button>'
    const opener = document.getElementById('opener')!
    opener.focus()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    function Dialog({ active }: { active: boolean }) {
      const ref = useModalFocus(active, vi.fn())
      return (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <button>first</button>
          <button>last</button>
        </div>
      )
    }

    const { rerender } = render(<Dialog active={false} />)
    rerender(<Dialog active={true} />)
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button')
    await vi.waitFor(() => expect(document.activeElement).toBe(buttons[0]))
    buttons[0].focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(window, { key: 'x' })

    rerender(<Dialog active={false} />)
    expect(document.activeElement).toBe(opener)
  })

  it('keeps focus on an empty dialog', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    function EmptyDialog() {
      const ref = useModalFocus(true, vi.fn())
      return <div ref={ref} role="dialog" tabIndex={-1} />
    }
    render(<EmptyDialog />)
    const dialog = screen.getByRole('dialog')
    dialog.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)
  })
})

describe('small components and stores', () => {
  it('renders every file icon family', () => {
    const { rerender } = render(<FileIcon entry={entry('dir', 'directory')} />)
    expect(document.querySelector('svg')).toHaveClass('text-brand-400')
    rerender(<FileIcon entry={entry('x.png')} />)
    expect(document.querySelector('svg')).toHaveClass('size-4')
    rerender(<FileIcon entry={entry('x.zip')} />)
    expect(document.querySelector('svg')).toHaveClass('size-4')
    rerender(<FileIcon entry={entry('x.ts')} />)
    expect(document.querySelector('svg')).toHaveClass('size-4')
    rerender(<FileIcon entry={entry('x.bin')} />)
    expect(document.querySelector('svg')).toHaveClass('size-4')
    expect([Folder, FileImage, FileArchive, FileText]).toHaveLength(4)
  })

  it('renders transfer states and fires retry and dismiss', () => {
    const onDismiss = vi.fn()
    const onRetry = vi.fn()
    const done = { id: 'done', tabId: 't', name: 'done', direction: 'download' as const, status: 'done' as const, progress: 100, bytes: 10, total: 10, startedAt: 1 }
    const error = { ...done, id: 'error', name: 'error', direction: 'upload' as const, status: 'error' as const, error: 'failed', speed: 10 }
    const queued = { ...done, id: 'queued', status: 'queued' as const, error: undefined }
    const active = { ...done, id: 'active', status: 'active' as const, speed: 1024, error: undefined }
    render(<TransferQueue transfers={[done, error, queued, active]} onDismiss={onDismiss} onRetry={onRetry} />)
    expect(screen.getByText('failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss done' }))
    expect(onRetry).toHaveBeenCalledWith('error')
    expect(onDismiss).toHaveBeenCalledWith('error')
    expect(onDismiss).toHaveBeenCalledWith('done')
    render(<TransferQueue transfers={[]} onDismiss={onDismiss} onRetry={onRetry} />)
  })

  it('supports password reveal, errors, ids, and refs', () => {
    const ref = { current: null as HTMLInputElement | null }
    render(
      <Input label="Password" type="password" error="Required" id="password" ref={ref} />,
    )
    const input = screen.getByLabelText('Password')
    expect(ref.current).toBe(input)
    expect(screen.getByRole('alert')).toHaveTextContent('Required')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('uses a forwarded callback ref and detects detached inputs', () => {
    const callback = vi.fn()
    const input = document.createElement('input')
    expect(browserDrawsRevealButton(input)).toBe(false)
    render(<Input aria-label="Name" ref={callback} />)
    expect(callback).toHaveBeenCalled()
  })

  it('covers the pane error boundary and fallback', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    class Broken extends Component {
      render() {
        throw new Error('broken')
      }
    }
    render(
      <PaneErrorBoundary fallback={<p>fallback</p>}>
        <Broken />
      </PaneErrorBoundary>,
    )
    expect(screen.getByText('fallback')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<PaneErrorFallback message="reload" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('exercises every layout tree branch', () => {
    const leafA = { type: 'leaf' as const, tabId: 'a' }
    const leafB = { type: 'leaf' as const, tabId: 'b' }
    const leafC = { type: 'leaf' as const, tabId: 'c' }
    const leafD = { type: 'leaf' as const, tabId: 'd' }
    const nested: PaneNode = {
      type: 'split', id: 'sp-nested', dir: 'v', ratio: 0.5,
      a: { type: 'split', id: 'sp-a', dir: 'h', ratio: 0.4, a: leafA, b: leafB },
      b: { type: 'split', id: 'sp-b', dir: 'h', ratio: 0.6, a: leafC, b: leafD },
    }
    expect(makeSplitId()).toMatch(/^sp-/)
    expect(getLayoutTabIds(nested)).toEqual(['a', 'b', 'c', 'd'])

    useLayoutStore.setState({ root: null, focusedTabId: null, dragTabId: null })
    useLayoutStore.getState().closePane('a')
    useLayoutStore.getState().updateRatio('x', 0.5)
    useLayoutStore.getState().swapTabs('a', 'b')

    useLayoutStore.getState().applyLayout(nested)
    expect(useLayoutStore.getState().focusedTabId).toBe('a')
    useLayoutStore.getState().setFocused('b')
    useLayoutStore.getState().setDragTab('a')
    expect(useLayoutStore.getState().dragTabId).toBe('a')
    useLayoutStore.getState().swapTabs('a', 'b')
    expect(getLayoutTabIds(useLayoutStore.getState().root!)).toEqual(['b', 'a', 'c', 'd'])
    useLayoutStore.getState().swapTabs('c', 'd')
    useLayoutStore.getState().swapTabs('none', 'other')
    useLayoutStore.getState().updateRatio('sp-a', 0.3)
    useLayoutStore.getState().updateRatio('sp-b', 0.7)
    useLayoutStore.getState().updateRatio('none', 0.5)
    useLayoutStore.getState().closePane('b')
    expect(useLayoutStore.getState().focusedTabId).toBe('a')
    useLayoutStore.getState().closePane('a')
    useLayoutStore.getState().closePane('c')
    useLayoutStore.getState().closePane('d')
    useLayoutStore.getState().closePane('missing')
    expect(useLayoutStore.getState().root).toBeNull()
    useLayoutStore.getState().closePane('a')
    useLayoutStore.getState().exitSplitMode()
    expect(useLayoutStore.getState().root).toBeNull()

    useLayoutStore.setState({ root: leafA })
    useLayoutStore.getState().closePane('a')
    expect(useLayoutStore.getState().root).toBeNull()

    useLayoutStore.setState({
      root: {
        type: 'split',
        id: 'outer',
        dir: 'h',
        ratio: 0.5,
        a: {
          type: 'split',
          id: 'inner',
          dir: 'v',
          ratio: 0.5,
          a: leafA,
          b: leafB,
        },
        b: leafC,
      },
      focusedTabId: 'a',
      dragTabId: null,
    })
    useLayoutStore.getState().closePane('b')
    expect(getLayoutTabIds(useLayoutStore.getState().root!)).toEqual(['a', 'c'])
    useLayoutStore.getState().closePane('missing')
  })

  it('covers saved server additions, updates, and imports', () => {
    useSavedServerStore.setState({ servers: [] })
    const base = { name: 'One', host: 'h', port: 22, username: 'u' }
    expect(useSavedServerStore.getState().addServer(base)).toBe(true)
    expect(useSavedServerStore.getState().addServer(base)).toBe(false)
    const id = useSavedServerStore.getState().servers[0].id
    expect(useSavedServerStore.getState().updateServer(id, { ...base, name: 'Changed' })).toBe(true)
    expect(useSavedServerStore.getState().updateServer(id, base)).toBe(true)
    expect(
      useSavedServerStore
        .getState()
        .updateServer('missing', { ...base, host: 'unique' }),
    ).toBe(true)
    useSavedServerStore.getState().removeServer(id)
    expect(useSavedServerStore.getState().servers).toHaveLength(0)
    useSavedServerStore.getState().importServers([{ ...base, id: 'old' }], 'replace')
    expect(useSavedServerStore.getState().servers[0].id).not.toBe('old')
    useSavedServerStore.getState().importServers([{ ...base, id: 'dup' }], 'merge')
    expect(useSavedServerStore.getState().servers).toHaveLength(1)
    useSavedServerStore.getState().importServers(
      [{ ...base, id: 'new', host: 'other' }],
      'merge',
    )
    expect(useSavedServerStore.getState().servers).toHaveLength(2)
  })

  it('covers broadcast toggles', () => {
    useBroadcastStore.setState({ enabled: false, excludedTabIds: [], splitOwned: false })
    useBroadcastStore.getState().toggle()
    expect(useBroadcastStore.getState().enabled).toBe(true)
    useBroadcastStore.getState().toggleTab('a')
    expect(useBroadcastStore.getState().excludedTabIds).toEqual(['a'])
    useBroadcastStore.getState().toggleTab('a')
    expect(useBroadcastStore.getState().excludedTabIds).toEqual([])
    useBroadcastStore.getState().setSplitOwned(true)
    expect(useBroadcastStore.getState().splitOwned).toBe(true)
    useBroadcastStore.getState().disable()
    expect(useBroadcastStore.getState().enabled).toBe(false)
  })

  it('covers terminal tab lifecycle and persistence migrations', () => {
    sessionStorage.clear()
    localStorage.clear()
    useTerminalStore.setState({ sessionId: 'session', tabs: [], activeTabId: null })
    const first = useTerminalStore.getState().addTab()
    const second = useTerminalStore.getState().addTab()
    expect(useTerminalStore.getState().getActiveTab()?.id).toBe(second)
    useTerminalStore.getState().setTabConnection(first, 'h', 22, 'u')
    useTerminalStore.getState().setTabStatus(first, 'connected')
    useTerminalStore.getState().renameTab(first, '  Production  ')
    useTerminalStore.getState().renameTab(first, '   ')
    useTerminalStore.getState().setTabSftpPath(first, '/a')
    useTerminalStore.getState().setTabSftpPath(first, '/a')
    const sftp = useTerminalStore.getState().addSftpTab(first)
    useTerminalStore.getState().setSourceTab(sftp, first)
    useTerminalStore.getState().setActiveTab(first)
    useTerminalStore.getState().moveTab(first, second)
    useTerminalStore.getState().moveTab('missing', second)
    useTerminalStore.getState().moveTab(first, first)
    useTerminalStore.getState().setActiveTab(sftp)
    useTerminalStore.getState().closeTab(sftp)
    expect(useTerminalStore.getState().activeTabId).toBe(first)
    useTerminalStore.getState().closeTab(first)
    useTerminalStore.getState().closeTab(second)
    expect(useTerminalStore.getState().activeTabId).toBeNull()
    useTerminalStore.getState().addTab()
    useTerminalStore.getState().closeAllTabs()
    expect(useTerminalStore.getState().tabs).toEqual([])
  })

  it('exits a broadcast-owned split when selecting an outside tab', () => {
    const outside = tab('outside')
    const inside = tab('inside')
    useTerminalStore.setState({ sessionId: 's', tabs: [outside, inside], activeTabId: 'inside' })
    useLayoutStore.setState({
      root: { type: 'leaf', tabId: 'inside' },
      focusedTabId: 'inside',
      dragTabId: null,
    })
    useBroadcastStore.setState({ enabled: true, excludedTabIds: [], splitOwned: true })
    useTerminalStore.getState().setActiveTab('outside')
    expect(useLayoutStore.getState().root).toBeNull()
    expect(useBroadcastStore.getState().enabled).toBe(false)
    expect(useBroadcastStore.getState().splitOwned).toBe(false)
  })

  it('covers every SFTP store action and selection shape', () => {
    useSFTPStore.setState({ tabs: {}, transfers: [] })
    const store = () => useSFTPStore.getState()
    store().setListingQuiet('t', '/x', [entry('a')])
    store().ensureTab('t')
    store().setUsername('t', 'alice')
    store().setIsRoot('t', true)
    store().setLoading('t', true)
    store().setError('t', 'bad')
    store().setNotice('t', { tone: 'success', message: 'ok' })
    store().setDisconnected('t', true)
    store().toggleSelected('t', '/a')
    store().toggleSelected('t', '/a')
    store().toggleSelected('t', '/a', ['/b', '/c'])
    store().setSelected('t', ['/d'])
    store().clearSelected('t')
    store().setListingQuiet('t', '/x', [])
    store().addTransfer({ id: 'x', tabId: 't', name: 'x', direction: 'upload', status: 'active', progress: 1, bytes: 1, total: 2 })
    store().updateTransfer('x', { status: 'done' })
    store().removeTransfer('x')
    expect(store().activeTransferCount()).toBe(0)
    store().setListing('new', '/', [])
    store().setUsername('new', null)
    store().setIsRoot('new', false)
    store().setLoading('new', false)
    store().setError('new', null)
    store().setNotice('new', null)
    store().setDisconnected('new', false)
    store().toggleSelected('new', '/x')
    store().setSelected('new', [])
    store().clearSelected('new')
  })
})

describe('CommandPalette full command set', () => {
  it('renders and runs every command variant', () => {
    const actions = {
      add: vi.fn(), select: vi.fn(), sftp: vi.fn(), settings: vi.fn(),
      split: vi.fn(), broadcast: vi.fn(), exit: vi.fn(), close: vi.fn(),
    }
    const tabs = [
      tab('a', { label: null }),
      tab('b', { type: 'sftp', label: 'Files' }),
    ]
    const view = render(
      <CommandPalette
        tabs={tabs}
        activeTabId="a"
        canSplit
        canBroadcast
        inSplitMode
        onAddTab={actions.add}
        onSelectTab={actions.select}
        onOpenSftpTab={actions.sftp}
        onOpenSettings={actions.settings}
        onOpenSplitPicker={actions.split}
        onOpenBroadcastPicker={actions.broadcast}
        onExitSplit={actions.exit}
        onClose={actions.close}
      />,
    )
    const search = screen.getByLabelText('Search commands and tabs')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.mouseEnter(screen.getByRole('option', { name: /New tab/ }))
    fireEvent.click(screen.getByRole('option', { name: /Exit split/ }))
    expect(actions.exit).toHaveBeenCalled()

    view.rerender(
      <CommandPalette
        tabs={tabs}
        activeTabId="a"
        canSplit
        canBroadcast={false}
        inSplitMode={false}
        onAddTab={actions.add}
        onSelectTab={actions.select}
        onOpenSftpTab={actions.sftp}
        onOpenSettings={actions.settings}
        onOpenSplitPicker={actions.split}
        onOpenBroadcastPicker={actions.broadcast}
        onExitSplit={actions.exit}
        onClose={actions.close}
      />,
    )
    fireEvent.click(screen.getByRole('option', { name: /Split/ }))
    expect(actions.split).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /Open SFTP/ }))
    expect(actions.sftp).toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Search commands and tabs'), { target: { value: 'nothing-matches' } })
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })
})
