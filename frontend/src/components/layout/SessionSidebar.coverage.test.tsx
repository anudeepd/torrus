import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionSidebar from './SessionSidebar'
import { useSavedServerStore } from '@/store/savedServerStore'
import { useTerminalStore } from '@/store/terminalStore'

const server = {
  id: 'server-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
}

const second = {
  id: 'server-2',
  name: 'Staging',
  host: 'stage.example.com',
  port: 2222,
  username: 'bob',
}

function renderSidebar(overrides: Partial<Parameters<typeof SessionSidebar>[0]> = {}) {
  const props = {
    isOpen: true,
    compact: false,
    onToggle: vi.fn(),
    onLoadSession: vi.fn(),
    ...overrides,
  }
  const view = render(<SessionSidebar {...props} />)
  return { ...props, ...view }
}

class MockFileReader {
  static result: string | ArrayBuffer | null = null
  static error = false
  result: string | ArrayBuffer | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsText() {
    this.result = MockFileReader.result
    queueMicrotask(() => {
      if (MockFileReader.error) this.onerror?.()
      else this.onload?.()
    })
  }
}

beforeEach(() => {
  vi.stubGlobal('FileReader', MockFileReader)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:sessions'),
    revokeObjectURL: vi.fn(),
  })
  localStorage.clear()
  useSavedServerStore.setState({ servers: [server, second] })
  useTerminalStore.setState({
    sessionId: 's',
    tabs: [{
      id: 'tab-1', type: 'terminal', host: server.host, port: server.port,
      username: server.username, label: null, status: 'connected', sessionKey: 's:tab-1',
    }],
    activeTabId: 'tab-1',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SessionSidebar coverage', () => {
  it('renders saved sessions, active state, compact and collapsed layouts', () => {
    const { rerender, onToggle } = renderSidebar()
    expect(screen.getByRole('navigation', { name: 'Saved sessions' })).toBeInTheDocument()
    expect(screen.getByText('alice@prod.example.com')).toBeInTheDocument()
    expect(screen.getByText('bob@stage.example.com:2222')).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByRole('button', { name: /Production/ }))
    expect(document.querySelector('.bg-green-400')).toBeInTheDocument()

    rerender(<SessionSidebar isOpen compact={false} onToggle={onToggle} onLoadSession={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide sessions' }))
    expect(onToggle).toHaveBeenCalled()

    rerender(<SessionSidebar isOpen={false} compact={false} onToggle={onToggle} onLoadSession={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show sessions' }))
    expect(onToggle).toHaveBeenCalledTimes(2)

    rerender(<SessionSidebar isOpen compact onToggle={onToggle} onLoadSession={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Close sessions drawer' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close sessions drawer' }))
    expect(onToggle).toHaveBeenCalledTimes(3)

    rerender(<SessionSidebar isOpen={false} compact onToggle={onToggle} onLoadSession={vi.fn()} />)
    expect(screen.queryByRole('navigation', { name: 'Saved sessions' })).not.toBeInTheDocument()
  })

  it('shows the empty state and handles selection, open, edit, and delete controls', async () => {
    useSavedServerStore.setState({ servers: [] })
    const { onLoadSession } = renderSidebar()
    expect(screen.getByText(/No saved sessions/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit session' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete session' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()

    act(() => {
      useSavedServerStore.setState({ servers: [server] })
    })
    fireEvent.click(await screen.findByText('Production'))
    const open = screen.getByRole('button', { name: 'Open', exact: true })
    expect(open).toBeEnabled()
    fireEvent.click(open)
    expect(onLoadSession).toHaveBeenCalledWith(server)

    fireEvent.click(screen.getByRole('button', { name: 'Edit session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  })

  it('validates the edit dialog fields and duplicate updates', async () => {
    renderSidebar()
    fireEvent.click(screen.getByText('Production'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit session' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit session' })
    const host = within(dialog).getByLabelText('Host')
    const username = within(dialog).getByLabelText('Username')
    const port = within(dialog).getByLabelText('Port')
    const name = within(dialog).getByLabelText('Name')

    fireEvent.change(host, { target: { value: ' ' } })
    fireEvent.submit(name.closest('form')!)
    expect(screen.getByText('Host is required.')).toBeInTheDocument()

    fireEvent.change(host, { target: { value: 'prod.example.com' } })
    fireEvent.change(username, { target: { value: ' ' } })
    fireEvent.submit(name.closest('form')!)
    expect(screen.getByText('Username is required.')).toBeInTheDocument()

    fireEvent.change(username, { target: { value: 'alice' } })
    fireEvent.change(port, { target: { value: '0' } })
    fireEvent.submit(name.closest('form')!)
    expect(screen.getByText('Port must be 1–65535.')).toBeInTheDocument()

    fireEvent.change(host, { target: { value: second.host } })
    fireEvent.change(username, { target: { value: second.username } })
    fireEvent.change(port, { target: { value: String(second.port) } })
    fireEvent.change(name, { target: { value: 'Renamed' } })
    fireEvent.submit(name.closest('form')!)
    expect(screen.getByText(/already exists/)).toBeInTheDocument()

    fireEvent.change(host, { target: { value: 'new.example.com' } })
    fireEvent.change(username, { target: { value: 'alice' } })
    fireEvent.change(port, { target: { value: '22' } })
    fireEvent.change(name, { target: { value: ' ' } })
    fireEvent.submit(name.closest('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit session' })).not.toBeInTheDocument())
    expect(useSavedServerStore.getState().servers.find(item => item.id === server.id)?.name).toBe(
      'alice@new.example.com',
    )
  })

  it('uses generic edit placeholders for an incomplete saved server', async () => {
    useSavedServerStore.setState({
      servers: [{ id: 'blank', name: 'Blank', host: '', port: 22, username: '' }],
    })
    renderSidebar()
    fireEvent.click(screen.getByText('Blank'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit session' }))
    expect(await screen.findByLabelText('Name')).toHaveAttribute(
      'placeholder',
      'user@host…',
    )
  })

  it('imports valid sessions and reports malformed or unreadable files', async () => {
    renderSidebar()
    const input = screen.getByLabelText('Import sessions file')
    const file = new File(['x'], 'sessions.json', { type: 'application/json' })

    MockFileReader.result = JSON.stringify({ servers: [second] })
    fireEvent.change(input, { target: { files: [file] } })
    await screen.findByRole('status')
    expect(useSavedServerStore.getState().servers).toHaveLength(2)

    MockFileReader.result = '{"servers":[{"name":"bad"}]}'
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid file')

    MockFileReader.result = 'not json'
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not parse JSON')

    MockFileReader.error = true
    MockFileReader.result = '[]'
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to read file')
    MockFileReader.error = false

    fireEvent.change(input, { target: { files: [] } })
  })

  it('validates every imported server shape and port', async () => {
    renderSidebar()
    const input = screen.getByLabelText('Import sessions file')
    const file = new File(['x'], 'sessions.json')
    for (const payload of [
      null,
      {},
      [null],
      [{ name: 'x', host: 'h', port: '22', username: 'u' }],
      [{ name: 'x', host: 'h', port: 0, username: 'u' }],
    ]) {
      MockFileReader.result = JSON.stringify(payload)
      fireEvent.change(input, { target: { files: [file] } })
      expect(await screen.findByRole('alert')).toHaveTextContent('Invalid file')
    }
    const array = [server]
    MockFileReader.result = JSON.stringify(array)
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('exports sessions and revokes the object URL', () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2000))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sessions')
  })

  it('resizes by pointer and keyboard with clamped persisted widths', () => {
    localStorage.setItem('torrus-sidebar-width', 'not-a-number')
    renderSidebar()
    const handle = screen.getByRole('separator', { name: 'Resize sessions sidebar' })
    fireEvent.mouseDown(handle, { clientX: 300 })
    fireEvent.mouseMove(document, { clientX: 900 })
    fireEvent.mouseUp(document)
    expect(localStorage.getItem('torrus-sidebar-width')).toBe('520')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(localStorage.getItem('torrus-sidebar-width')).toBe('208')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(localStorage.getItem('torrus-sidebar-width')).toBe('520')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(localStorage.getItem('torrus-sidebar-width')).toBe('504')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'x' })

    cleanup()
    localStorage.setItem('torrus-sidebar-width', '999')
    const view = renderSidebar()
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '520')
    view.unmount()
  })

  it('opens and dismisses context menus with mouse and keyboard', () => {
    renderSidebar()
    const row = screen.getByText('Production').closest('button')!
    fireEvent.contextMenu(row, { clientX: 5, clientY: 6 })
    expect(screen.getByRole('menu', { name: 'Session actions' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(row)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    fireEvent.keyDown(row, { key: 'x' })
  })

  it('opens, edits, and deletes from the context menu', async () => {
    const { onLoadSession } = renderSidebar()
    const row = screen.getByText('Production').closest('button')!
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(onLoadSession).toHaveBeenCalledWith(server)

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }))
    expect(screen.queryByText('Production')).not.toBeInTheDocument()
  })

  it('keeps a menu from rendering after its server disappears', () => {
    renderSidebar()
    const row = screen.getByText('Production').closest('button')!
    fireEvent.contextMenu(row)
    act(() => {
      useSavedServerStore.setState({ servers: [second] })
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
