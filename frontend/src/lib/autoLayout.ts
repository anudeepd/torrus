import { makeSplitId, type PaneNode } from '@/store/layoutStore'

function leaf(tabId: string): PaneNode {
  return { type: 'leaf', tabId }
}

function h(a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'h', ratio: 0.5, a, b }
}

function v(a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: makeSplitId(), dir: 'v', ratio: 0.5, a, b }
}

export function autoLayout(tabIds: string[]): PaneNode | null {
  if (tabIds.length === 0) return null
  if (tabIds.length === 1) return leaf(tabIds[0])
  if (tabIds.length === 2) return h(leaf(tabIds[0]), leaf(tabIds[1]))
  if (tabIds.length === 3) return h(leaf(tabIds[0]), v(leaf(tabIds[1]), leaf(tabIds[2])))
  if (tabIds.length === 4) return h(v(leaf(tabIds[0]), leaf(tabIds[2])), v(leaf(tabIds[1]), leaf(tabIds[3])))
  return h(v(leaf(tabIds[0]), leaf(tabIds[1])), autoLayout(tabIds.slice(2))!)
}
