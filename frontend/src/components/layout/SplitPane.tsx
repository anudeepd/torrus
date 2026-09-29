import { Suspense, lazy, useRef, useCallback, useState, useEffect } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Socket } from 'socket.io-client'
import type { PaneNode } from '@/store/layoutStore'
import { useLayoutStore } from '@/store/layoutStore'
import { useTerminalStore } from '@/store/terminalStore'
import { PaneErrorBoundary } from '@/components/ui/PaneErrorBoundary'
const TerminalPane = lazy(() => import('@/components/terminal/TerminalPane'))
const SFTPBrowser = lazy(() => import('@/components/sftp/SFTPBrowser'))

interface SplitPaneProps {
  node: PaneNode
  socket: Socket
  onClose: (tabId: string) => void
  isOnlyPane: boolean
}

function LeafPaneErrorFallback({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  return (
    <div className="flex flex-col w-full h-full bg-surface-950 items-center justify-center p-4">
      <AlertTriangle className="size-8 text-red-400 mb-2" aria-hidden="true" />
      <p className="text-sm text-slate-300 mb-2 text-pretty">Pane failed to load</p>
      <p className="text-xs text-slate-400 mb-3 text-pretty">Tab: {tabId}</p>
      <button
        onClick={onClose}
        className="rounded bg-surface-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:bg-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Close pane
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
  const focusedTabId = useLayoutStore(s => s.focusedTabId)
  const setFocused = useLayoutStore(s => s.setFocused)
  const dragTabId = useLayoutStore(s => s.dragTabId)
  const setDragTab = useLayoutStore(s => s.setDragTab)
  const swapTabs = useLayoutStore(s => s.swapTabs)
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
      id={`torrus-panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`torrus-tab-${tabId}`}
      className={cn(
        'flex flex-col w-full h-full transition-[outline-color]',
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
        className={cn(
          'flex-shrink-0 h-7 flex items-center justify-between px-2 border-b border-surface-800 select-none cursor-grab active:cursor-grabbing transition-colors',
          dragOver && dragTabId !== tabId
            ? 'bg-brand-500/20 border-brand-500'
            : 'bg-surface-900'
        )}
      >
        <span className="text-xs text-slate-400 font-mono truncate">{label}</span>
        {!isOnlyPane && (
          <button
            type="button"
            onMouseDown={e => e.stopPropagation()}
            onClick={() => onClose(tabId)}
            title="Close pane"
            aria-label="Close pane"
            className="flex-shrink-0 rounded-md p-0.5 text-slate-400 hover:bg-surface-800 hover:text-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        <PaneErrorBoundary fallback={<LeafPaneErrorFallback tabId={tabId} onClose={() => onClose(tabId)} />}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-400">Loading…</div>}>
            {tab?.type === 'sftp' ? (
              <SFTPBrowser tabId={tabId} sourceTabId={tab.sourceTabId} socket={socket} />
            ) : (
              <TerminalPane
                tabId={tabId}
                isActive={true}
                focused={isFocused}
                socket={socket}
              />
            )}
          </Suspense>
        </PaneErrorBoundary>
      </div>
    </div>
  )
}

const KEYBOARD_RESIZE_STEP = 0.02

function ResizeHandle({
  dir,
  ratio,
  onDrag,
  onRatio,
}: {
  dir: 'h' | 'v'
  ratio: number
  onDrag: (delta: number) => void
  onRatio: (ratio: number) => void
}) {
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

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    dragging.current = false
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch { /* releasePointerCapture may throw if pointer not captured */ }
  }, [])

  return (
    <div
      // A separator with a keyboard path: WCAG 2.5.7 wants a non-dragging way to
      // resize, and the arrow keys below are that. The sidebar's handle uses the
      // same pattern.
      role="separator"
      aria-label={dir === 'h' ? 'Resize panes' : 'Resize stacked panes'}
      aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={10}
      aria-valuemax={90}
      tabIndex={0}
      className={cn(
        'flex-shrink-0 bg-surface-800 hover:bg-brand-500 active:bg-brand-400 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        dir === 'h' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      )}
      onKeyDown={event => {
        const grow = dir === 'h' ? 'ArrowRight' : 'ArrowDown'
        const shrink = dir === 'h' ? 'ArrowLeft' : 'ArrowUp'
        if (event.key !== grow && event.key !== shrink) return
        event.preventDefault()
        const step = event.key === grow ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
        onRatio(Math.max(0.1, Math.min(0.9, ratio + step)))
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
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
      className={cn('flex w-full h-full', node.dir === 'h' ? 'flex-row' : 'flex-col')}
    >
      <div style={{ flex: node.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <SplitPane node={node.a} socket={socket} onClose={onClose} isOnlyPane={false} />
      </div>
      <ResizeHandle
        dir={node.dir}
        ratio={node.ratio}
        onDrag={handleDrag}
        onRatio={ratio => updateRatio(node.id, ratio)}
      />
      <div style={{ flex: 1 - node.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <SplitPane node={node.b} socket={socket} onClose={onClose} isOnlyPane={false} />
      </div>
    </div>
  )
}
