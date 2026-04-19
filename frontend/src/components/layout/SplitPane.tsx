import { useRef, useCallback, useState, useEffect, Component, type ReactNode } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import type { Socket } from 'socket.io-client'
import type { PaneNode } from '@/store/layoutStore'
import { useLayoutStore } from '@/store/layoutStore'
import { useTerminalStore } from '@/store/terminalStore'
import TerminalPane from '@/components/terminal/TerminalPane'

interface SplitPaneProps {
  node: PaneNode
  socket: Socket
  onClose: (tabId: string) => void
  isOnlyPane: boolean
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

class LeafErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}

function LeafPaneErrorFallback({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  return (
    <div className="flex flex-col w-full h-full bg-surface-900 items-center justify-center p-4">
      <AlertTriangle className="w-8 h-8 text-red-400 mb-2" />
      <p className="text-sm text-slate-300 mb-2">Terminal failed to load</p>
      <p className="text-xs text-slate-500 mb-3">Tab: {tabId}</p>
      <button
        onClick={onClose}
        className="text-xs px-3 py-1 bg-surface-700 hover:bg-surface-600 text-slate-200 rounded"
      >
        Close Pane
      </button>
    </div>
  )
}

function LeafPane({ tabId, socket, onClose, isOnlyPane }: {
  tabId: string
  socket: Socket
  onClose: (tabId: string) => void
  isOnlyPane: boolean
}) {
  const tab = useTerminalStore(s => s.tabs.find(t => t.id === tabId))
  const { focusedTabId, setFocused, dragTabId, setDragTab, swapTabs } = useLayoutStore()
  const isFocused = focusedTabId === tabId
  const [dragOver, setDragOver] = useState(false)

  // Cleanup drag state on window blur to handle interrupted drags
  useEffect(() => {
    const onWindowBlur = () => {
      if (dragTabId) {
        setDragTab(null)
        setDragOver(false)
      }
    }
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [dragTabId, setDragTab])

  const label = tab
    ? (tab.label ?? (tab.host && tab.username ? `${tab.username}@${tab.host}` : 'New Connection'))
    : tabId

  return (
    <div
      className={clsx(
        'flex flex-col w-full h-full',
        isFocused ? 'outline outline-1 outline-brand-500' : 'outline outline-1 outline-surface-700'
      )}
      onMouseDown={() => setFocused(tabId)}
    >
      {/* Draggable pane header */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          setDragTab(tabId)
        }}
        onDragEnd={() => { setDragTab(null); setDragOver(false) }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (dragTabId && dragTabId !== tabId) swapTabs(dragTabId, tabId)
          setDragTab(null)
        }}
        className={clsx(
          'flex-shrink-0 h-7 flex items-center justify-between px-2 border-b border-surface-800 select-none cursor-grab active:cursor-grabbing transition-colors',
          dragOver && dragTabId !== tabId
            ? 'bg-brand-500/20 border-brand-500'
            : 'bg-surface-900'
        )}
      >
        <span className="text-xs text-slate-400 font-mono truncate">{label}</span>
        {!isOnlyPane && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={() => onClose(tabId)}
            title="Close pane"
            className="flex-shrink-0 p-0.5 text-slate-500 hover:text-red-400 transition-colors rounded"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        <LeafErrorBoundary fallback={<LeafPaneErrorFallback tabId={tabId} onClose={() => onClose(tabId)} />}>
          <TerminalPane
            tabId={tabId}
            isActive={true}
            focused={isFocused}
            socket={socket}
          />
        </LeafErrorBoundary>
      </div>
    </div>
  )
}

function ResizeHandle({ dir, onDrag }: { dir: 'h' | 'v'; onDrag: (delta: number) => void }) {
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    lastPos.current = dir === 'h' ? e.clientX : e.clientY
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [dir])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const pos = dir === 'h' ? e.clientX : e.clientY
    onDrag(pos - lastPos.current)
    lastPos.current = pos
  }, [dir, onDrag])

  const onPointerUp = useCallback(() => { dragging.current = false }, [])

  return (
    <div
      className={clsx(
        'flex-shrink-0 bg-surface-800 hover:bg-brand-500 active:bg-brand-400 transition-colors',
        dir === 'h' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

export default function SplitPane({ node, socket, onClose, isOnlyPane }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const updateRatio = useLayoutStore(s => s.updateRatio)

  if (node.type === 'leaf') {
    return <LeafPane tabId={node.tabId} socket={socket} onClose={onClose} isOnlyPane={isOnlyPane} />
  }

  const handleDrag = (delta: number) => {
    const el = containerRef.current
    if (!el) return
    const total = node.dir === 'h' ? el.offsetWidth : el.offsetHeight
    if (total === 0) return
    updateRatio(node.id, Math.max(0.1, Math.min(0.9, node.ratio + delta / total)))
  }

  return (
    <div
      ref={containerRef}
      className={clsx('flex w-full h-full', node.dir === 'h' ? 'flex-row' : 'flex-col')}
    >
      <div style={{ flex: node.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <SplitPane node={node.a} socket={socket} onClose={onClose} isOnlyPane={false} />
      </div>
      <ResizeHandle dir={node.dir} onDrag={handleDrag} />
      <div style={{ flex: 1 - node.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <SplitPane node={node.b} socket={socket} onClose={onClose} isOnlyPane={false} />
      </div>
    </div>
  )
}
