import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TransferQueue from './TransferQueue'

const transfer = {
  id: 'upload-1', tabId: 'sftp-1', direction: 'upload' as const,
  name: 'release.tar.gz', bytes: 50, total: 100, progress: 50, status: 'active' as const, startedAt: 1,
}

describe('TransferQueue', () => {
  it('shows each active transfer in a floating progress notification stack', () => {
    const secondTransfer = {
      ...transfer,
      id: 'upload-2',
      name: 'database.sql.gz',
      bytes: 25,
      progress: 25,
    }

    render(<TransferQueue transfers={[transfer, secondTransfer]} onDismiss={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getByText('release.tar.gz')).toBeInTheDocument()
    expect(screen.getByText('database.sql.gz')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'release.tar.gz transfer progress' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('progressbar', { name: 'database.sql.gz transfer progress' })).toHaveAttribute('aria-valuenow', '25')
  })
})
