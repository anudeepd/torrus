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

  it('moves up from absolute top-level folders to filesystem root', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/home',
        entries: [],
      })
    })

    socket.emit.mockClear()
    fireEvent.click(screen.getByTitle('Go to parent folder (Backspace)'))
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '/' }))

    act(() => {
      socket._trigger('sftp:list:result', {
        tab_id: tabId,
        ok: true,
        path: '/',
        entries: [],
      })
    })

    socket.emit.mockClear()
    fireEvent.click(screen.getByTitle('Go to parent folder (Backspace)'))
    expect(socket.emit).toHaveBeenCalledWith('sftp:list', expect.objectContaining({ path: '/' }))
  })

  it('does not display absolute paths as home-relative breadcrumbs', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/tmp/anudeep',
        entries: [],
      })
    })

    expect(screen.queryByRole('button', { name: '~' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '/' })).toHaveClass('text-slate-600', 'text-xs')
    expect(screen.getByText('/', { selector: 'span' })).toHaveClass('font-mono', 'text-xs')
    expect(screen.getByRole('button', { name: 'tmp' })).toHaveAttribute('title', '/tmp')
    expect(screen.getByRole('button', { name: 'anudeep' })).toHaveAttribute('title', '/tmp/anudeep')
  })

  it('shows non-blocking feedback when a drop event is delayed', () => {
    vi.useFakeTimers()
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    const browser = screen.getByRole('listbox', { name: 'File browser' })
    fireEvent.dragOver(browser)
    expect(screen.getByText('Drop files to upload')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('Drop files to upload')).toBeInTheDocument()

    fireEvent.dragOver(browser)
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('Drop files to upload')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByText('Drop files to upload')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Preparing upload…')

    act(() => vi.advanceTimersByTime(14_999))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing upload…')

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status')).toHaveTextContent("Upload hasn't started yet.")

    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Choose files' }))
    expect(inputClick).toHaveBeenCalledOnce()
    inputClick.mockRestore()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss upload status' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('dismisses the new-folder modal with Escape', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    fireEvent.click(screen.getByTitle('Create new folder'))
    expect(screen.getByRole('dialog', { name: 'New folder' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'New folder' })).not.toBeInTheDocument()
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
          uid: 1000,
          gid: 1001,
        }],
      })
    })

    expect(screen.getByText('ROOT')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(1)
    expect(screen.getByText('permissions')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /app\.log.*owner 1000.*permissions 7640 rwSr-S--T/i })).toBeInTheDocument()
    expect(screen.getByText('1000')).toHaveAttribute('title', '1000:1001 (uid 1000, gid 1001)')
    expect(screen.getByText('7640')).toHaveAttribute('title', '7640 rwSr-S--T')

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/i }), { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(screen.getByRole('checkbox', { name: 'Setuid' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Setgid' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Sticky' })).toBeChecked()
    expect(screen.getByText('rwSr-S--T')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Setuid' }))
    expect(screen.getByText(/3640/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Setuid' }))
    expect(screen.getByRole('checkbox', { name: 'Owner Execute' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Owner Execute' }))
    expect(screen.getByText('rwsr-S--T')).toBeInTheDocument()
    expect(screen.getByText(/7740/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Owner UID' }), { target: { value: '2000' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Group GID' }), { target: { value: '2001' } })

    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:chmod', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/var/log/app.log',
      mode: 0o7740,
    })
    expect(socket.emit).toHaveBeenCalledWith('sftp:chown', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/var/log/app.log',
      uid: 2000,
      gid: 2001,
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
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to delete item: Permission denied.')
    expect(screen.getByRole('alert')).toHaveTextContent('ERROR')
    expect(screen.getByText('Failed to delete item: Permission denied.')).toHaveClass('break-words')

    act(() => vi.advanceTimersByTime(11999))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps failed transfers visible until dismissed', () => {
    vi.useFakeTimers()
    useSFTPStore.setState({
      transfers: [{
        id: 'failed-upload',
        tabId,
        name: 'restricted.txt',
        direction: 'upload',
        status: 'error',
        progress: 40,
        bytes: 40,
        total: 100,
        startedAt: Date.now(),
        error: 'Permission denied',
      }],
    })
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Permission denied')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss restricted.txt' }))
    expect(screen.queryByText('Permission denied')).not.toBeInTheDocument()
  })

  it('sets the active descendant for keyboard-selected files', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{ name: 'app.log', path: '/var/log/app.log', type: 'file', size: 2, mtime: 1 }],
      })
    })

    const browser = screen.getByRole('listbox', { name: 'File browser' })
    fireEvent.keyDown(browser, { key: 'ArrowDown' })
    expect(browser).toHaveAttribute('aria-activedescendant', `sftp-entry-${tabId}-${encodeURIComponent('/var/log/app.log')}`)
  })

  it('clears selected files when clicking blank browser space', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{
          name: 'app.log',
          path: '/var/log/app.log',
          type: 'file',
          size: 2,
          mtime: 1,
          mode: 0o100644,
        }],
      })
    })

    fireEvent.click(screen.getByRole('option', { name: /app\.log/i }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('listbox'))
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('toggles row selection with a plain click', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{
          name: 'app.log',
          path: '/var/log/app.log',
          type: 'file',
          size: 2,
          mtime: 1,
          mode: 0o100644,
        }],
      })
    })

    const row = screen.getByRole('option', { name: /app\.log/i })
    fireEvent.click(row)
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(row)
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    expect(row).toHaveAttribute('aria-selected', 'false')
  })

  it('uses the standard modal title typography for delete confirmation', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{ name: 'app.log', path: '/var/log/app.log', type: 'file', size: 2, mtime: 1 }],
      })
    })

    fireEvent.click(screen.getByRole('option', { name: /app\.log/i }))
    fireEvent.click(screen.getByTitle('Delete selection (Delete)'))

    const title = screen.getByRole('heading', { name: 'Delete item?' })
    expect(title).toHaveClass('text-sm', 'font-semibold')
  })

  it('clears selected files from the footer button', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{
          name: 'app.log',
          path: '/var/log/app.log',
          type: 'file',
          size: 2,
          mtime: 1,
          mode: 0o100644,
        }],
      })
    })

    fireEvent.click(screen.getByRole('option', { name: /app\.log/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('changes ownership using remote account lists', () => {
    const socket = createMockSocket()
    render(<SFTPBrowser tabId={tabId} sourceTabId="terminal-tab" socket={socket as unknown as Socket} />)

    act(() => {
      socket._trigger('sftp:open:result', {
        tab_id: tabId,
        ok: true,
        path: '/var/log',
        entries: [{
          name: 'app.log',
          path: '/var/log/app.log',
          type: 'file',
          size: 2,
          mtime: 1,
          mode: 0o100640,
          uid: 1000,
          gid: 1000,
          owner: 'app',
          group: 'app',
        }],
      })
    })

    expect(screen.getByText('app')).toHaveAttribute('title', 'app:app (uid 1000, gid 1000)')

    fireEvent.contextMenu(screen.getByRole('option', { name: /app\.log/i }), { clientX: 40, clientY: 40 })
    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:accounts', {
      session_id: 'test-session',
      tab_id: tabId,
    })

    act(() => {
      socket._trigger('sftp:accounts:result', {
        tab_id: tabId,
        ok: true,
        users: [{ uid: 1000, name: 'app' }, { uid: 1001, name: 'svc' }],
        groups: [{ gid: 1000, name: 'app' }, { gid: 1002, name: 'svcgrp' }],
      })
    })

    fireEvent.change(screen.getByRole('combobox', { name: 'Owner' }), { target: { value: '1001' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: '1002' } })

    socket.emit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(socket.emit).toHaveBeenCalledWith('sftp:chown', {
      session_id: 'test-session',
      tab_id: tabId,
      path: '/var/log/app.log',
      uid: 1001,
      gid: 1002,
    })
  })
})
