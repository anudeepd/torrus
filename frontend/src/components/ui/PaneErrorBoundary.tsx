import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface PaneErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
}

interface PaneErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * Keeps one failed pane or chunk from taking the whole app down.
 *
 * Code-split surfaces load their chunk on demand and the hashed asset name
 * changes on every build, so a stale shell or a refused fetch makes the dynamic
 * import reject. Without a boundary React 18 unmounts the root and the user gets
 * a blank page, so every `Suspense` around a lazy component needs one of these.
 */
export class PaneErrorBoundary extends Component<PaneErrorBoundaryProps, PaneErrorBoundaryState> {
  state: PaneErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Pane error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}

/** The shell's plain "reload to recover" fallback, shared by every pane that
 * doesn't need its own (e.g. SplitPane's leaf panes have a close affordance
 * too, so they keep their own `LeafPaneErrorFallback` instead). */
export function PaneErrorFallback({ message }: { message: string }) {
  return (
    <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface-950">
      <AlertTriangle aria-hidden="true" className="size-8 text-red-400" />
      <p className="text-sm text-slate-300 text-pretty">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded bg-surface-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:bg-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Reload
      </button>
    </div>
  )
}
