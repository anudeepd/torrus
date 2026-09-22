import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LayoutPickerModal from './LayoutPickerModal'
import { useLayoutStore } from '@/store/layoutStore'

const twoTabs = [
  { id: 'tab-1', type: 'terminal' as const, host: 'a', port: 22, username: 'root', label: 'One', status: 'connected' as const, sessionKey: 's:tab-1' },
  { id: 'tab-2', type: 'terminal' as const, host: 'b', port: 22, username: 'root', label: 'Two', status: 'connected' as const, sessionKey: 's:tab-2' },
]

describe('LayoutPickerModal', () => {
  afterEach(() => {
    cleanup()
    useLayoutStore.setState({ root: null, focusedTabId: null, dragTabId: null })
  })

  it('keeps Apply disabled until every slot has a tab, then applies the layout', () => {
    const onApply = vi.fn()
    render(<LayoutPickerModal tabs={twoTabs} onClose={() => {}} onApply={onApply} />)

    // The default preset needs two slots and two tabs are open, so Apply starts enabled.
    expect(screen.getByRole('button', { name: 'Apply layout' })).toBeEnabled()

    // A three-slot preset cannot be filled from two tabs.
    fireEvent.click(screen.getByRole('button', { name: /Main \+ 2 right/ }))
    expect(screen.getByRole('button', { name: 'Apply layout' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Side by side/ }))
    expect(screen.getByRole('button', { name: 'Apply layout' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }))

    expect(onApply).toHaveBeenCalledOnce()
    const node = onApply.mock.calls[0][0]
    expect(node.type).toBe('split')
    expect(node.dir).toBe('h')
    expect([node.a.tabId, node.b.tabId]).toEqual(['tab-1', 'tab-2'])
  })

  it('closes without applying when cancelled', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<LayoutPickerModal tabs={twoTabs} onClose={onClose} onApply={onApply} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onApply).not.toHaveBeenCalled()
  })
})
