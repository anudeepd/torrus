import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Socket } from 'socket.io-client'
import type { ConnectFormValues } from '@/types'
import ConnectForm from './ConnectForm'
import { useTerminalStore } from '@/store/terminalStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useBroadcastStore } from '@/store/broadcastStore'

interface TerminalPaneProps {
  tabId: string
  isActive: boolean
  focused?: boolean  // if provided, controls term.focus(); falls back to isActive
  socket: Socket
}

const ANSI_ESCAPE = String.fromCharCode(0x1b)
const SCROLLBACK_CLEAR_SEQUENCE = new RegExp(`${ANSI_ESCAPE}\\[[?]?(?:3J)`, 'g')
const TERMINAL_REPLY_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE}(?:\\[(?:\\?|>|!|=)?[0-9;]*[cRn]|\\][0-9;]*(?:;[^${ANSI_ESCAPE}\\x07]*)?(?:\\x07|${ANSI_ESCAPE}\\\\))`,
  'g'
)
const RESTORE_INPUT_SUPPRESSION_MS = 800

function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function bracketTextForPaste(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text
}

function stripScrollbackClearSequences(data: string): string {
  return data.replace(SCROLLBACK_CLEAR_SEQUENCE, '')
}

function isTerminalReplyOnly(data: string): boolean {
  if (!data.includes(ANSI_ESCAPE)) return false
  return data.replace(TERMINAL_REPLY_SEQUENCE, '') === ''
}

function isVisibleTerminalContainer(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0
}

interface CachedTerminal {
  term: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
}

// Module-level cache: terminal buffer must survive remounts when exiting split mode.
const terminalCache = new Map<string, CachedTerminal>()
// Pending dispose timeouts — cleared on remount to prevent disposing reused terminals
const pendingDisposeTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

function clearPendingDispose(tabId: string) {
  const t = pendingDisposeTimeouts.get(tabId)
  if (t) {
    clearTimeout(t)
    pendingDisposeTimeouts.delete(tabId)
  }
}

export default function TerminalPane({ tabId, isActive, focused, socket }: TerminalPaneProps) {
  const { sessionId, tabs, setTabStatus, setTabConnection } = useTerminalStore()
  const tab = tabs.find(t => t.id === tabId)

  const settings = useSettingsStore()
  const broadcastEnabled = useBroadcastStore(s => s.enabled)
  const broadcastExcluded = useBroadcastStore(s => s.excludedTabIds)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const errorRef = useRef<string>('')
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const protectScrollbackUntilRef = useRef(0)
  const [connectionError, setConnectionError] = useState('')
  // Suppress xterm onData during session restore to prevent terminal query
  // responses (OSC 11, DSR, DA) from being echoed back to the remote shell
  const suppressInputRef = useRef(true)
  const suppressInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks actual xterm.js keyboard focus — only the focused terminal broadcasts.
  // Prevents other panes' DA/DSR escape responses from leaking into all terminals.
  const hasFocusRef = useRef(false)
  // Cache connected tab IDs for broadcast to avoid per-keystroke iteration
  const broadcastTargetIdsRef = useRef<Set<string>>(new Set())
  // Focus handlers for cleanup
  const handleFocus = useCallback(() => { hasFocusRef.current = true }, [])
  const handleBlur = useCallback(() => { hasFocusRef.current = false }, [])

  // Compute broadcast targets efficiently — only when connected tabs actually change
  const broadcastTargets = useMemo(() => {
    if (!broadcastEnabled) return new Set<string>()
    return new Set(
      tabs.filter(t => t.type === 'terminal' && t.status === 'connected' && !broadcastExcluded.includes(t.id)).map(t => t.id)
    )
  }, [tabs, broadcastEnabled, broadcastExcluded])

  useEffect(() => {
    broadcastTargetIdsRef.current = broadcastTargets
  }, [broadcastTargets])

  const suppressRestoreInputBriefly = useCallback(() => {
    suppressInputRef.current = true
    if (suppressInputTimerRef.current) clearTimeout(suppressInputTimerRef.current)
    suppressInputTimerRef.current = setTimeout(() => {
      suppressInputRef.current = false
      suppressInputTimerRef.current = null
    }, RESTORE_INPUT_SUPPRESSION_MS)
  }, [])

  const emitInput = useCallback((data: string) => {
    if (suppressInputRef.current) return
    if (isTerminalReplyOnly(data)) return

    const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (currentTab?.status !== 'connected') return

    const { enabled } = useBroadcastStore.getState()

    if (enabled && hasFocusRef.current && broadcastTargetIdsRef.current.size > 0) {
      for (const targetTabId of broadcastTargetIdsRef.current) {
        if (targetTabId !== tabId) {
          socket.emit('ssh:input', { session_id: sessionId, tab_id: targetTabId, data })
        }
      }
    }
    socket.emit('ssh:input', { session_id: sessionId, tab_id: tabId, data })
  }, [tabId, socket, sessionId])

  const emitResize = useCallback((term: Terminal) => {
    socket.emit('terminal:resize', {
      session_id: sessionId,
      tab_id: tabId,
      cols: term.cols,
      rows: term.rows,
    })
  }, [socket, sessionId, tabId])

  const fitAndEmitResize = useCallback((term: Terminal, fitAddon: FitAddon) => {
    if (!isVisibleTerminalContainer(containerRef.current)) return
    const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY
    fitAddon.fit()
    if (wasAtBottom) term.scrollToBottom()
    if (term.cols <= 0 || term.rows <= 0) return

    const previous = lastResizeRef.current
    if (previous?.cols === term.cols && previous?.rows === term.rows) return

    lastResizeRef.current = { cols: term.cols, rows: term.rows }
    emitResize(term)
  }, [emitResize])

  const scheduleFitAndEmitResize = useCallback((term: Terminal, fitAddon: FitAddon) => {
    if (resizeFrameRef.current !== null) return
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null
      fitAndEmitResize(term, fitAddon)
    })
  }, [fitAndEmitResize])

  const installCustomKeyHandler = useCallback((term: Terminal) => {
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const isModifierKey = ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'].includes(e.key)
      if (e.type === 'keydown' && !e.isComposing && !mod && !e.altKey && !isModifierKey) {
        e.preventDefault()
      }
      if (mod && (key === 'w' || key === 't' || key === ',')) return false
      if (e.ctrlKey && key === 'tab') return false
      if (mod && key === 'f') return false
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'c') {
        if (term.hasSelection()) return false
        emitInput('\x03')
        return false
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'l') {
        protectScrollbackUntilRef.current = Date.now() + 1000
      }
      if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && key === 'c' && term.hasSelection()) return false
      if (mod && key === 'v') return false
      return true
    })
  }, [emitInput])

  // Create or reuse xterm.js terminal
  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const { scrollbackLines, fontSize } = useSettingsStore.getState()

    let cancelled = false
    let ro: ResizeObserver | null = null
    let textarea: HTMLTextAreaElement | null = null
    let handlePaste: ((event: ClipboardEvent) => void) | null = null
    let onDataDisposable: { dispose: () => void } | null = null

    const init = async () => {
      try {
        await document.fonts.load(`normal ${fontSize}px "JetBrains Mono"`)
      } catch {
        console.warn("Failed to preload JetBrains Mono font; terminal may use fallback")
      }
      if (cancelled || !containerRef.current || termRef.current) return

      clearPendingDispose(tabId)
      const cached = terminalCache.get(tabId)
      if (cached) {
        // Reuse existing terminal (e.g. remounting after exiting split mode)
        containerRef.current.appendChild(cached.container)
        termRef.current = cached.term
        fitRef.current = cached.fitAddon
        installCustomKeyHandler(cached.term)

        textarea = cached.term.textarea ?? null
        if (textarea) {
          textarea.addEventListener('focus', handleFocus)
          textarea.addEventListener('blur', handleBlur)
        }

        handlePaste = (event: ClipboardEvent) => {
          const text = event.clipboardData?.getData('text/plain')
          if (text == null) return
          event.preventDefault()
          event.stopPropagation()
          const bracketedPasteMode =
            cached.term.modes.bracketedPasteMode && cached.term.options.ignoreBracketedPasteMode !== true
          const prepared = bracketTextForPaste(prepareTextForTerminal(text), bracketedPasteMode)
          emitInput(prepared)
        }
        textarea?.addEventListener('paste', handlePaste, true)

        onDataDisposable = cached.term.onData((data) => {
          emitInput(data)
        })

        ro = new ResizeObserver(() => {
          const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
          if (currentTab?.status === 'connected' && isVisibleTerminalContainer(containerRef.current)) {
            scheduleFitAndEmitResize(cached.term, cached.fitAddon)
          }
        })
        ro.observe(containerRef.current)

        fitAndEmitResize(cached.term, cached.fitAddon)

        const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
        if (currentTab?.status === 'connected') {
          suppressInputRef.current = false
        }
      } else {
        const termContainer = document.createElement('div')
        termContainer.className = 'absolute inset-0'
        containerRef.current.appendChild(termContainer)

        const term = new Terminal({
          fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
          fontSize,
          fontWeight: 'normal',
          fontWeightBold: 'bold',
          lineHeight: 1.2,
          cursorBlink: true,
          cursorStyle: 'block',
          scrollback: scrollbackLines,
          macOptionClickForcesSelection: true,
          rightClickSelectsWord: true,
          allowTransparency: false,
          theme: {
            background:          '#020617',
            foreground:          '#e2e8f0',
            cursor:              '#34d399',
            cursorAccent:        '#020617',
            selectionBackground: 'rgba(52,211,153,0.25)',
            black:               '#1e293b',
            red:                 '#f87171',
            green:               '#10b981',
            yellow:              '#facc15',
            blue:                '#34d399',
            magenta:             '#c084fc',
            cyan:                '#0d9488',
            white:               '#cbd5e1',
            brightBlack:         '#475569',
            brightRed:           '#fca5a5',
            brightGreen:         '#6ee7b7',
            brightYellow:        '#fde047',
            brightBlue:          '#6ee7b7',
            brightMagenta:       '#d8b4fe',
            brightCyan:          '#2dd4bf',
            brightWhite:         '#f1f5f9',
          },
        })

        const fitAddon = new FitAddon()
        const webLinksAddon = new WebLinksAddon((event: MouseEvent, uri: string) => {
          if (uri.startsWith('javascript:') || uri.startsWith('data:') || uri.startsWith('vbscript:')) {
            event.preventDefault()
            return
          }
          window.open(uri, '_blank', 'noopener,noreferrer')
        })
        term.loadAddon(fitAddon)
        term.loadAddon(webLinksAddon)

        installCustomKeyHandler(term)
        term.attachCustomWheelEventHandler((e) => {
          e.stopPropagation()
          return true
        })

        term.open(termContainer)
        fitAndEmitResize(term, fitAddon)

        termRef.current = term
        fitRef.current = fitAddon
        terminalCache.set(tabId, { term, fitAddon, container: termContainer })

        const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
        if (currentTab?.status === 'connected') {
          suppressInputRef.current = false
        }

        onDataDisposable = term.onData((data) => {
          emitInput(data)
        })

        textarea = (term as unknown as { textarea?: HTMLTextAreaElement }).textarea ?? null
        if (!textarea && termContainer) {
          textarea = termContainer.querySelector('textarea') ?? null
        }
        if (textarea) {
          textarea.addEventListener('focus', handleFocus)
          textarea.addEventListener('blur', handleBlur)
        }

        handlePaste = (event: ClipboardEvent) => {
          const text = event.clipboardData?.getData('text/plain')
          if (text == null) return
          event.preventDefault()
          event.stopPropagation()
          const bracketedPasteMode =
            term.modes.bracketedPasteMode && term.options.ignoreBracketedPasteMode !== true
          const prepared = bracketTextForPaste(prepareTextForTerminal(text), bracketedPasteMode)
          emitInput(prepared)
        }
        textarea?.addEventListener('paste', handlePaste, true)

        ro = new ResizeObserver(() => {
          const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
          if (currentTab?.status === 'connected' && isVisibleTerminalContainer(containerRef.current)) {
            scheduleFitAndEmitResize(term, fitAddon)
          }
        })
        ro.observe(containerRef.current)
      }
    }

    init()

    return () => {
      cancelled = true
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      ro?.disconnect()
      if (textarea) {
        textarea.removeEventListener('focus', handleFocus)
        textarea.removeEventListener('blur', handleBlur)
        if (handlePaste) textarea.removeEventListener('paste', handlePaste, true)
      }
      onDataDisposable?.dispose()

      const cached = terminalCache.get(tabId)
      if (cached && cached.container.parentNode) {
        cached.container.parentNode.removeChild(cached.container)
      }

      // If the tab was actually closed, dispose the cached terminal
      clearPendingDispose(tabId)
      const disposeTimeout = setTimeout(() => {
        const tabExists = useTerminalStore.getState().tabs.some(t => t.id === tabId)
        if (!tabExists) {
          const cached = terminalCache.get(tabId)
          if (cached) {
            cached.term.dispose()
            terminalCache.delete(tabId)
          }
        }
        pendingDisposeTimeouts.delete(tabId)
      }, 0)
      pendingDisposeTimeouts.set(tabId, disposeTimeout)

      termRef.current = null
      fitRef.current = null
      hasFocusRef.current = false
    }
  }, [tabId, emitInput, emitResize, fitAndEmitResize, scheduleFitAndEmitResize, installCustomKeyHandler, handleFocus, handleBlur])

  // Apply settings changes to live terminal
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    term.options.scrollback = settings.scrollbackLines
    term.options.fontSize = settings.fontSize

    if (fitRef.current && isVisibleTerminalContainer(containerRef.current)) {
      fitAndEmitResize(term, fitRef.current)
    }
  }, [settings.scrollbackLines, settings.fontSize, fitAndEmitResize])

  // Suppress input while Socket.IO is disconnected (prevents xterm escape
  // sequences from reaching the shell during reconnect windows)
  useEffect(() => {
    const onDisconnect = () => { suppressInputRef.current = true }
    socket.on('disconnect', onDisconnect)
    return () => { socket.off('disconnect', onDisconnect) }
  }, [socket])

  // SSH output → terminal
  useEffect(() => {
    const onOutput = ({ tab_id, data }: { tab_id: string; data: unknown }) => {
      if (tab_id !== tabId || !termRef.current) return
      if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        termRef.current.write(protectScrollbackUntilRef.current > Date.now()
          ? stripScrollbackClearSequences(new TextDecoder().decode(bytes))
          : bytes
        )
      } else if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data)
        termRef.current.write(protectScrollbackUntilRef.current > Date.now()
          ? stripScrollbackClearSequences(new TextDecoder().decode(bytes))
          : bytes
        )
      } else if (typeof data === 'string') {
        termRef.current.write(protectScrollbackUntilRef.current > Date.now() ? stripScrollbackClearSequences(data) : data)
      } else {
        console.warn('Received unexpected data type from ssh:output:', typeof data)
      }
    }
    socket.on('ssh:output', onOutput)
    return () => { socket.off('ssh:output', onOutput) }
  }, [socket, tabId])

  // Session restore / ssh:connected / ssh:error / ssh:closed
  useEffect(() => {
    let mounted = true
    const onRestored = ({ tab_id, status }: { tab_id: string; status: string }) => {
      if (tab_id !== tabId) return
      if (status === 'active') {
        setTabStatus(tabId, 'connected')
        requestAnimationFrame(() => {
          if (!mounted) return
          if (termRef.current && fitRef.current) {
            fitAndEmitResize(termRef.current, fitRef.current)
          }
          termRef.current?.focus()
          suppressRestoreInputBriefly()
        })
      } else {
        suppressInputRef.current = false
        setTabStatus(tabId, 'disconnected')
      }
    }

    const onConnected = ({ tab_id }: { tab_id: string }) => {
      if (tab_id !== tabId) return
      errorRef.current = ''
      setConnectionError('')
      setTabStatus(tabId, 'connected')
      requestAnimationFrame(() => {
        if (!mounted) return
        if (termRef.current && fitRef.current) {
          fitAndEmitResize(termRef.current, fitRef.current)
        }
        termRef.current?.focus()
        suppressRestoreInputBriefly()
      })
    }

    const onError = ({ tab_id, message }: { tab_id: string; message: string }) => {
      if (tab_id !== tabId) return
      errorRef.current = message
      setConnectionError(message)
      suppressInputRef.current = true
      setTabStatus(tabId, 'dead')
    }

    const onClosed = ({ tab_id, reason }: { tab_id: string; reason: string }) => {
      if (tab_id !== tabId) return
      suppressInputRef.current = true
      setTabStatus(tabId, 'dead')
      termRef.current?.write(`\r\n\x1b[38;5;244m[torrus: ${reason}]\x1b[0m\r\n`)
    }

    socket.on('session:restored', onRestored)
    socket.on('ssh:connected', onConnected)
    socket.on('ssh:error', onError)
    socket.on('ssh:closed', onClosed)

    return () => {
      mounted = false
      if (suppressInputTimerRef.current) {
        clearTimeout(suppressInputTimerRef.current)
        suppressInputTimerRef.current = null
      }
      socket.off('session:restored', onRestored)
      socket.off('ssh:connected', onConnected)
      socket.off('ssh:error', onError)
      socket.off('ssh:closed', onClosed)
    }
  }, [socket, tabId, setTabStatus, fitAndEmitResize, suppressRestoreInputBriefly])

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && tab?.status === 'connected') {
      requestAnimationFrame(() => {
        if (termRef.current && fitRef.current) {
          fitAndEmitResize(termRef.current, fitRef.current)
        }
        if (focused ?? true) termRef.current?.focus()
      })
    }
  }, [isActive, focused, tab?.status, fitAndEmitResize])

  const handleConnect = useCallback((values: ConnectFormValues) => {
    errorRef.current = ''
    setTabStatus(tabId, 'connecting')
    setTabConnection(tabId, values.host, values.port, values.username)
    const term = termRef.current
    socket.emit('ssh:connect', {
      session_id: sessionId,
      tab_id: tabId,
      host: values.host,
      port: values.port,
      username: values.username,
      password: values.password,
      cols: term ? term.cols : 220,
      rows: term ? term.rows : 50,
    })
  }, [socket, sessionId, tabId, setTabStatus, setTabConnection])

  const showForm = !tab || tab.status === 'disconnected' || tab.status === 'dead'

  return (
    <div className="relative w-full h-full">
      {/* xterm.js container — always mounted so the terminal persists */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ display: showForm ? 'none' : 'block' }}
      />

      {/* Connection form overlay */}
      {showForm && (
        <ConnectForm
          initialHost={tab?.host ?? undefined}
          initialPort={tab?.port ?? undefined}
          initialUsername={tab?.username ?? undefined}
          error={tab?.status === 'dead' ? (connectionError || 'Connection closed.') : undefined}
          onConnect={handleConnect}
        />
      )}
    </div>
  )
}
