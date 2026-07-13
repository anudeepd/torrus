import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import SFTPBrowser from './SFTPBrowser'
import { useSFTPStore } from '@/store/sftpStore'
import { useTerminalStore } from '@/store/terminalStore'
import { createMockSocket } from '@/test/mocks/socket'

describe('SFTPBrowser', () => {
  const tabId = 'sftp-tab'

  beforeEach(() => {
    useSFTPStore.setState({ tabs: {}, transfers: [] })
    useTerminalStore.setState({
      sessionId: 'test-session',
      activeTabId: tabId,
      tabs: [{
        id: tabId,
        type: 'sftp',
        host: 'server.example',
        port: 22,
        username: 'root',
        label: 'SFTP root@server.example',
        status: 'connecting',
        sessionKey: `test-session:${tabId}`,
        sourceTabId: 'terminal-tab',
      }],
    })
  })

  afterEach(() => vi.useRealTimers())

  it('shows an explicit root breadcrumb for the filesystem root', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/',
        entries: [],
      })
    })

    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '/' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '/' }))
  })

  it('supports breadcrumbs, root identity, context chmod, and a styled folder dialog', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        username: 'root',
        is_root: true,
        entries: [{
          name: 'app.log',
          path: '/var/log/app.log',
          type: 'file',
          size: 2,
          mtime: 1,
          mode: 0o107640,
        }],
      })
    })

    expect(screen.getByText('ROOT')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(1)
    expect(screen.getByText('permissions')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /app\.log.*permissions 7640/i })).toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/i }), { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(screen.getByRole('checkbox', { name: 'Setuid' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Setgid' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Sticky' })).toBeChecked()
    expect(screen.getByText('rwSr-S--T')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Setuid' }))
    expect(screen.getByText('3640')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Setuid' }))
    expect(screen.getByRole('checkbox', { name: 'Owner Execute' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Owner Execute' }))
    expect(screen.getByText('rwsr-S--T')).toBeInTheDocument()
    expect(screen.getByText('7740')).toBeInTheDocument()

    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:chmod', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/var/log/app.log',
      mode: 0o7740,
    })

    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'var' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '/var' }))

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
    expect(screen.getByRole('heading', { name: 'New folder' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'archive' } })
    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:mkdir', expect.objectContaining({ path: '/var/log/archive' }))
  })

  it('auto-dismisses operation errors', () => {
    vi.useFakeTimers()
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:delete:result', {
        tab_id: tabId,
        ok: false,
        results: [{ ok: false, code: 'PERMISSION_DENIED', message: 'Permission denied.' }],
      })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Permission denied.')

    act(() => vi.advanceTimersByTime(11999))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
