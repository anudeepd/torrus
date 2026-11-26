import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import SessionSidebar from './SessionSidebar'
import { useSavedServerStore } from '@/store/savedServerStore'

const server = {
  id: 'server-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    useSavedServerStore.setState({ servers: [server] })
  })

  it('focuses the name field when the edit dialog opens', async () => {
    render(
      <SessionSidebar
        isOpen
        compact={false}
        onToggle={vi.fn()}
        onLoadSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('Production'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit session' }))

    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(document.activeElement).toBe(name))
  })

  it('opens a saved session from its context menu', async () => {
    const onLoadSession = vi.fn()
    render(
      <SessionSidebar
        isOpen
        compact={false}
        onToggle={vi.fn()}
        onLoadSession={onLoadSession}
      />,
    )

    fireEvent.contextMenu(screen.getByText('Production'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))

    expect(onLoadSession).toHaveBeenCalledWith(server)
  })

  it('deletes a saved session from its context menu', async () => {
    render(
      <SessionSidebar
        isOpen
        compact={false}
        onToggle={vi.fn()}
        onLoadSession={vi.fn()}
      />,
    )

    fireEvent.contextMenu(screen.getByText('Production'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(screen.queryByText('Production')).not.toBeInTheDocument()
  })
})
