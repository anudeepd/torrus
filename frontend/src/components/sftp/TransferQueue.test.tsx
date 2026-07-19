import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TransferQueue from './TransferQueue'

const transfer = {
  id: 'upload-1', tabId: 'sftp-1', direction: 'upload' as const,
  name: 'release.tar.gz', bytes: 50, total: 100, progress: 50, status: 'active' as const, startedAt: 1,
}

describe('TransferQueue', () => {
  it('smoothly collapses and restores its transfer content', () => {
    render(<TransferQueue transfers={[transfer]} onDismiss={vi.fn()} onRetry={vi.fn()} onClearCompleted={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: /Transfers/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('release.tar.gz')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('release.tar.gz')).toBeInTheDocument()
  })
})
