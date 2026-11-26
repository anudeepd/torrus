import { afterEach, describe, expect, it } from 'vitest'
import { getLayoutTabIds, useLayoutStore, type PaneNode } from './layoutStore'

const tree: PaneNode = {
  type: 'split',
  id: 'root',
  dir: 'h',
  ratio: 0.5,
  a: { type: 'leaf', tabId: 'a' },
  b: {
    type: 'split',
    id: 'nested',
    dir: 'v',
    ratio: 0.5,
    a: { type: 'leaf', tabId: 'b' },
    b: { type: 'leaf', tabId: 'c' },
  },
}

afterEach(() => {
  useLayoutStore.setState({ root: null, focusedTabId: null, dragTabId: null })
})

describe('layoutStore', () => {
  it('leaves the tree untouched when closing a tab that is not present', () => {
    useLayoutStore.setState({ root: tree, focusedTabId: 'a', dragTabId: null })
    useLayoutStore.getState().closePane('missing')

    const root = useLayoutStore.getState().root!
    expect(getLayoutTabIds(root)).toEqual(['a', 'b', 'c'])
    expect(root).toEqual(tree)
    expect(useLayoutStore.getState().focusedTabId).toBe('a')
  })

  it('collapses a leaf root when its tab closes', () => {
    useLayoutStore.setState({
      root: { type: 'leaf', tabId: 'only' },
      focusedTabId: 'only',
      dragTabId: null,
    })
    useLayoutStore.getState().closePane('only')
    expect(useLayoutStore.getState().root).toBeNull()
    expect(useLayoutStore.getState().focusedTabId).toBeNull()
  })
})
