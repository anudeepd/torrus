import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SplitPane from './SplitPane'
import { useLayoutStore, type PaneNode } from '@/store/layoutStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'

const state = vi.hoisted(() => ({ throwFor: '' }))

vi.mock('@/components/terminal/TerminalPane', () => ({
  default: ({ tabId }: { tabId: string }) => {
    if (tabId === state.throwFor) throw new Error('pane failed')
    return <div data-testid={`terminal-${tabId}`} />
  },
}))
vi.mock('@/components/sftp/SFTPBrowser', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-testid={`sftp-${tabId}`} />,
}))

const socket = createMockSocket()

function setTabs(tabs = useTerminalStore.getState().tabs) {
  useTerminalStore.setState({
    sessionId: 's',
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  })
}

afterEach(() => {
  state.throwFor = ''
  useLayoutStore.setState({ root: null, focusedTabId: null, dragTabId: null })
  useTerminalStore.setState({ tabs: [], activeTabId: null })
  vi.restoreAllMocks()
})

Object.defineProperty(Element.prototype, 'setPointerCapture', {
  configurable: true,
  value: vi.fn(),
})
Object.defineProperty(Element.prototype, 'releasePointerCapture', {
  configurable: true,
  value: vi.fn(),
})

describe('SplitPane', () => {
  it('renders terminal and SFTP leaves with labels and close affordances', async () => {
    const onClose = vi.fn()
    setTabs([
      {
        id: 't1', type: 'terminal', host: 'db', port: 22, username: 'alice',
        label: null, status: 'connected', sessionKey: 's:t1',
      },
      {
        id: 't2', type: 'sftp', host: null, port: null, username: null,
        label: null, status: 'connected', sessionKey: 's:t2', sourceTabId: 't1',
      },
      {
        id: 't3', type: 'terminal', host: null, port: null, username: null,
        label: 'Named', status: 'connected', sessionKey: 's:t3',
      },
    ])
    useLayoutStore.setState({ focusedTabId: 't1', dragTabId: null, root: null })

    const { rerender } = render(
      <SplitPane
        node={{ type: 'leaf', tabId: 't1' }}
        socket={socket}
        onClose={onClose}
        isOnlyPane={false}
      />,
    )
    await screen.findByTestId('terminal-t1')
    expect(screen.getByText('alice@db')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('tabpanel'))
    expect(useLayoutStore.getState().focusedTabId).toBe('t1')
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Close pane' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }))
    expect(onClose).toHaveBeenCalledWith('t1')

    rerender(
      <SplitPane
        node={{ type: 'leaf', tabId: 't2' }}
        socket={socket}
        onClose={onClose}
        isOnlyPane
      />,
    )
    await screen.findByTestId('sftp-t2')
    expect(screen.getByText('New Connection')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close pane' })).not.toBeInTheDocument()

    rerender(
      <SplitPane
        node={{ type: 'leaf', tabId: 't3' }}
        socket={socket}
        onClose={onClose}
        isOnlyPane
      />,
    )
    await screen.findByTestId('terminal-t3')
    expect(screen.getByText('Named')).toBeInTheDocument()

    rerender(
      <SplitPane
        node={{ type: 'leaf', tabId: 'missing' }}
        socket={socket}
        onClose={onClose}
        isOnlyPane
      />,
    )
    await screen.findByTestId('terminal-missing')
    expect(screen.getByText('missing')).toBeInTheDocument()
  })

  it('swaps leaves through drag and drop and clears interrupted drags on blur', async () => {
    setTabs([
      { id: 'a', type: 'terminal', host: 'a', port: 22, username: 'u', label: 'A', status: 'connected', sessionKey: 's:a' },
      { id: 'b', type: 'terminal', host: 'b', port: 22, username: 'u', label: 'B', status: 'connected', sessionKey: 's:b' },
    ])
    useLayoutStore.setState({ focusedTabId: 'a', dragTabId: null, root: null })
    const tree: PaneNode = {
      type: 'split',
      id: 'root',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'leaf', tabId: 'a' },
      b: { type: 'leaf', tabId: 'b' },
    }
    render(<SplitPane node={tree} socket={socket} onClose={vi.fn()} isOnlyPane={false} />)
    await screen.findByTestId('terminal-a')
    const panelA = document.getElementById('torrus-panel-a')!
    const headerA = panelA.firstElementChild as HTMLElement
    const panelB = document.getElementById('torrus-panel-b')!
    const headerB = panelB.firstElementChild as HTMLElement
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() } as unknown as DataTransfer

    fireEvent.dragStart(headerA, { dataTransfer })
    expect(useLayoutStore.getState().dragTabId).toBe('a')
    fireEvent.dragOver(headerB, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.dragLeave(headerB)
    fireEvent.drop(headerB, { dataTransfer })
    expect(useLayoutStore.getState().dragTabId).toBeNull()

    fireEvent.dragStart(headerA, { dataTransfer })
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(useLayoutStore.getState().dragTabId).toBeNull()
    fireEvent.dragEnd(headerA, { dataTransfer })

    fireEvent.dragOver(headerA, { dataTransfer })
    fireEvent.drop(headerA, { dataTransfer })
  })

  it('resizes horizontal and vertical panes with pointer and keyboard input', async () => {
    setTabs([
      { id: 'a', type: 'terminal', host: 'a', port: 22, username: 'u', label: 'A', status: 'connected', sessionKey: 's:a' },
      { id: 'b', type: 'terminal', host: 'b', port: 22, username: 'u', label: 'B', status: 'connected', sessionKey: 's:b' },
    ])
    useLayoutStore.setState({
      focusedTabId: 'a',
      dragTabId: null,
      root: null,
    })
    const tree: PaneNode = {
      type: 'split',
      id: 'root',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'leaf', tabId: 'a' },
      b: { type: 'leaf', tabId: 'b' },
    }
    const { container, rerender } = render(
      <SplitPane node={tree} socket={socket} onClose={vi.fn()} isOnlyPane={false} />,
    )
    await screen.findByTestId('terminal-a')
    const divider = screen.getByRole('separator', { name: 'Resize panes' })
    fireEvent.pointerMove(divider, { clientX: 20, pointerId: 1 })
    Object.defineProperty(container.firstElementChild, 'offsetWidth', { configurable: true, value: 0 })
    fireEvent.pointerDown(divider, { clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 20, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    fireEvent.pointerCancel(divider, { pointerId: 1 })
    const release = vi.mocked(Element.prototype.releasePointerCapture)
    release.mockImplementationOnce(() => { throw new Error('not captured') })
    fireEvent.pointerCancel(divider, { pointerId: 1 })
    Object.defineProperty(container.firstElementChild, 'offsetWidth', { configurable: true, value: 100 })
    fireEvent.pointerDown(divider, { clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 30, pointerId: 1 })
    expect(useLayoutStore.getState().root).toBeNull()
    fireEvent.pointerMove(divider, { clientX: 35, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'x' })

    rerender(
      <SplitPane
        node={{ ...tree, dir: 'v' }}
        socket={socket}
        onClose={vi.fn()}
        isOnlyPane={false}
      />,
    )
    const vertical = screen.getByRole('separator', { name: 'Resize stacked panes' })
    fireEvent.pointerDown(vertical, { clientY: 1, pointerId: 2 })
    fireEvent.pointerMove(vertical, { clientY: 10, pointerId: 2 })
    fireEvent.pointerUp(vertical, { pointerId: 2 })
    Object.defineProperty(container.firstElementChild, 'offsetHeight', { configurable: true, value: 100 })
    fireEvent.pointerDown(vertical, { clientY: 1, pointerId: 2 })
    fireEvent.pointerMove(vertical, { clientY: 20, pointerId: 2 })
    fireEvent.keyDown(vertical, { key: 'ArrowDown' })
    fireEvent.keyDown(vertical, { key: 'ArrowUp' })
  })

  it('shows a closeable fallback when a lazy pane throws', async () => {
    state.throwFor = 'broken'
    setTabs([
      { id: 'broken', type: 'terminal', host: 'bad', port: 22, username: 'u', label: 'Broken', status: 'connected', sessionKey: 's:broken' },
    ])
    const onClose = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <SplitPane
        node={{ type: 'leaf', tabId: 'broken' }}
        socket={socket}
        onClose={onClose}
        isOnlyPane={false}
      />,
    )
    await waitFor(() => expect(screen.getByText('Pane failed to load')).toBeInTheDocument())
    fireEvent.click(
      within(screen.getByText('Pane failed to load').parentElement!).getByRole(
        'button',
        { name: 'Close pane' },
      ),
    )
    expect(onClose).toHaveBeenCalledWith('broken')
  })
})
