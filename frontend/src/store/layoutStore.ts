import { create } from 'zustand'

export type Leaf = { type: 'leaf'; tabId: string }
export type SplitNode = {
  type: 'split'
  id: string
  dir: 'h' | 'v'
  ratio: number
  a: PaneNode
  b: PaneNode
}
export type PaneNode = Leaf | SplitNode

export function makeSplitId() {
  return `sp-${Math.random().toString(36).slice(2, 9)}`
}

function removeLeaf(node: PaneNode, tabId: string): [PaneNode | null, boolean] {
  if (node.type === 'leaf') {
    return node.tabId === tabId ? [null, true] : [node, false]
  }
  if (node.a.type === 'leaf' && node.a.tabId === tabId) return [node.b, true]
  if (node.b.type === 'leaf' && node.b.tabId === tabId) return [node.a, true]
  const [newA, foundA] = removeLeaf(node.a, tabId)
  if (foundA) return [{ ...node, a: newA! }, true]
  const [newB, foundB] = removeLeaf(node.b, tabId)
  if (foundB) return [{ ...node, b: newB! }, true]
  return [node, false]
}

function updateSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio }
  return { ...node, a: updateSplitRatio(node.a, splitId, ratio), b: updateSplitRatio(node.b, splitId, ratio) }
}

function swapInTree(node: PaneNode, a: string, b: string): PaneNode {
  if (node.type === 'leaf') {
    if (node.tabId === a) return { ...node, tabId: b }
    if (node.tabId === b) return { ...node, tabId: a }
    return node
  }
  return { ...node, a: swapInTree(node.a, a, b), b: swapInTree(node.b, a, b) }
}

export function getLayoutTabIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.tabId]
  return [...getLayoutTabIds(node.a), ...getLayoutTabIds(node.b)]
}

interface LayoutState {
  root: PaneNode | null
  focusedTabId: string | null
  dragTabId: string | null

  applyLayout: (root: PaneNode) => void
  closePane: (tabId: string) => void
  updateRatio: (splitId: string, ratio: number) => void
  setFocused: (tabId: string) => void
  setDragTab: (tabId: string | null) => void
  swapTabs: (tabId1: string, tabId2: string) => void
  exitSplitMode: () => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  root: null,
  focusedTabId: null,
  dragTabId: null,

  applyLayout: (root) => set({ root, focusedTabId: getLayoutTabIds(root)[0] }),

  closePane: (tabId) => set(s => {
    if (s.root === null) return {}
    const [newRoot] = removeLeaf(s.root, tabId)
    if (newRoot === null) return { root: null, focusedTabId: null }
    const newFocus = s.focusedTabId === tabId ? getLayoutTabIds(newRoot)[0] : s.focusedTabId
    return { root: newRoot, focusedTabId: newFocus }
  }),

  updateRatio: (splitId, ratio) => set(s => {
    if (s.root === null) return {}
    return { root: updateSplitRatio(s.root, splitId, ratio) }
  }),

  setFocused: (tabId) => set({ focusedTabId: tabId }),

  setDragTab: (tabId) => set({ dragTabId: tabId }),

  swapTabs: (tabId1, tabId2) => set(s => {
    if (!s.root) return {}
    return { root: swapInTree(s.root, tabId1, tabId2) }
  }),

  exitSplitMode: () => set({ root: null, focusedTabId: null, dragTabId: null }),
}))
