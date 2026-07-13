import { beforeEach, describe, expect, it } from 'vitest'
import { useSFTPStore } from './sftpStore'

describe('sftpStore', () => {
  beforeEach(() => {
    useSFTPStore.setState({ tabs: {}, transfers: [] })
  })

  it('stores directory listings and clears selection on navigation', () => {
    const store = useSFTPStore.getState()
    store.setSelected('tab1', ['/tmp/old'])
    store.setListing('tab1', '/tmp', [
      { name: 'a.txt', path: '/tmp/a.txt', type: 'file', size: 1, mtime: 1 },
    ])

    const tab = useSFTPStore.getState().tabs.tab1
    expect(tab.path).toBe('/tmp')
    expect(tab.entries[0].name).toBe('a.txt')
    expect(tab.selectedPaths).toEqual([])
  })

  it('toggles selection and supports transfer progress', () => {
    const store = useSFTPStore.getState()
    store.ensureTab('tab1')
    store.toggleSelected('tab1', '/tmp/a.txt')
    store.addTransfer({
      id: 'xfer1',
      tabId: 'tab1',
      name: 'a.txt',
      direction: 'upload',
      status: 'active',
      progress: 10,
      bytes: 1,
      total: 10,
    })
    store.updateTransfer('xfer1', { progress: 100, status: 'done' })

    expect(useSFTPStore.getState().tabs.tab1.selectedPaths).toEqual(['/tmp/a.txt'])
    expect(useSFTPStore.getState().transfers[0].status).toBe('done')
  })
})
