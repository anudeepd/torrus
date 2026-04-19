import { useEffect, useRef, useCallback } from 'react'
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

function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function bracketTextForPaste(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text
}

export default function TerminalPane({ tabId, isActive, focused, socket }: TerminalPaneProps) {
  const { sessionId, tabs, setTabStatus, setTabConnection } = useTerminalStore()
  const tab = tabs.find(t => t.id === tabId)

  const settings = useSettingsStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const errorRef = useRef<string>('')
  // Suppress xterm onData during session restore to prevent terminal query
  // responses (OSC 11, DSR, DA) from being echoed back to the remote shell
  const suppressInputRef = useRef(true)
  // Tracks actual xterm.js keyboard focus — only the focused terminal broadcasts.
  // Prevents other panes' DA/DSR escape responses from leaking into all terminals.
  const hasFocusRef = useRef(false)
  // Cache connected tab IDs for broadcast to avoid per-keystroke iteration
  const broadcastTargetIdsRef = useRef<Set<string>>(new Set())
  // Focus handlers for cleanup
  const handleFocus = useCallback(() => { hasFocusRef.current = true }, [])
  const handleBlur = useCallback(() => { hasFocusRef.current = false }, [])

  // Update cache when broadcast is enabled/disabled or when tabs change
  useEffect(() => {
    const allTabs = useTerminalStore.getState().tabs
    const { enabled, excludedTabIds } = useBroadcastStore.getState()
    if (!enabled) {
      broadcastTargetIdsRef.current = new Set()
      return
    }
    broadcastTargetIdsRef.current = new Set(
      allTabs.filter(t => t.status === 'connected' && !excludedTabIds.includes(t.id)).map(t => t.id)
    )
  }, [])

  const emitInput = useCallback((data: string) => {
    if (suppressInputRef.current) return

    const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (currentTab?.status !== 'connected') return

    const { enabled } = useBroadcastStore.getState()

    if (enabled && hasFocusRef.current && broadcastTargetIdsRef.current.size > 0) {
      for (const targetTabId of broadcastTargetIdsRef.current) {
        socket.emit('ssh:input', { session_id: sessionId, tab_id: targetTabId, data })
      }
    } else {
      socket.emit('ssh:input', { session_id: sessionId, tab_id: tabId, data })
    }
  }, [tabId, socket, sessionId])

  const emitResize = useCallback((term: Terminal) => {
    socket.emit('terminal:resize', {
      session_id: sessionId,
      tab_id: tabId,
      cols: term.cols,
      rows: term.rows,
    })
  }, [socket, sessionId, tabId])

  // Create xterm.js terminal once
  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const { scrollbackLines, fontSize } = useSettingsStore.getState()

    let cancelled = false
    let ro: ResizeObserver | null = null
    let textarea: HTMLTextAreaElement | null = null
    let handlePaste: ((event: ClipboardEvent) => void) | null = null

    const init = async () => {
      // Wait for JetBrains Mono to be ready so xterm.js measures cells correctly
      await document.fonts.load(`normal ${fontSize}px "JetBrains Mono"`).catch(() => {})

      // Bail out if the component unmounted while we were waiting
      if (cancelled || !containerRef.current || termRef.current) return

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
        fontSize,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: scrollbackLines,
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
      const webLinksAddon = new WebLinksAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(webLinksAddon)

      // Let the browser/app handle shortcuts instead of xterm
      term.attachCustomKeyEventHandler((e) => {
        const mod = e.ctrlKey || e.metaKey
        const key = e.key.toLowerCase()

        // App shortcuts — pass to AppLayout's keydown handler
        if (mod && (key === 'w' || key === 't' || key === ',')) return false
        if (e.ctrlKey && key === 'tab') return false

        // Ctrl+F: let the browser open its native find dialog
        if (mod && key === 'f') return false

        // Ctrl+C: copy when text is selected, otherwise let xterm send SIGINT
        if (mod && key === 'c' && term.hasSelection()) return false

        // Ctrl+V: let the browser fire a paste event (xterm handles it natively)
        if (mod && key === 'v') return false

        return true
      })

      term.open(containerRef.current)
      fitAddon.fit()

      termRef.current = term
      fitRef.current = fitAddon

      // Keystrokes → SSH input
      term.onData((data) => {
        emitInput(data)
      })

      textarea = term.textarea ?? null
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

      // Resize observer
      ro = new ResizeObserver(() => {
        const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
        if (currentTab?.status === 'connected') {
          fitAddon.fit()
          emitResize(term)
        }
      })
      ro.observe(containerRef.current)
    }

    init()

    return () => {
      cancelled = true
      ro?.disconnect()
      if (textarea) {
        textarea.removeEventListener('focus', handleFocus)
        textarea.removeEventListener('blur', handleBlur)
        if (handlePaste) textarea.removeEventListener('paste', handlePaste, true)
      }
      if (termRef.current) {
        termRef.current.dispose()
        termRef.current = null
        fitRef.current = null
      }
      hasFocusRef.current = false
    }
  }, [tabId, emitInput, emitResize, handleFocus, handleBlur])

  // Apply settings changes to live terminal
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    term.options.scrollback = settings.scrollbackLines
    term.options.fontSize = settings.fontSize

    fitRef.current?.fit()
    if (tab?.status === 'connected') {
      emitResize(term)
    }
  }, [settings.scrollbackLines, settings.fontSize, tab?.status, emitResize])

  // Suppress input while Socket.IO is disconnected (prevents xterm escape
  // sequences from reaching the shell during reconnect windows)
  useEffect(() => {
    const onDisconnect = () => { suppressInputRef.current = true }
    socket.on('disconnect', onDisconnect)
    return () => { socket.off('disconnect', onDisconnect) }
  }, [socket])

  // SSH output → terminal
  useEffect(() => {
    const onOutput = ({ tab_id, data }: { tab_id: string; data: ArrayBuffer | Uint8Array | string }) => {
      if (tab_id !== tabId || !termRef.current) return
      if (data instanceof ArrayBuffer) {
        termRef.current.write(new Uint8Array(data))
      } else if (data instanceof Uint8Array) {
        termRef.current.write(data)
      } else {
        termRef.current.write(data)
      }
    }
    socket.on('ssh:output', onOutput)
    return () => { socket.off('ssh:output', onOutput) }
  }, [socket, tabId])

  // Session restore / ssh:connected / ssh:error / ssh:closed
  useEffect(() => {
    const onRestored = ({ tab_id, status }: { tab_id: string; status: string }) => {
      if (tab_id !== tabId) return
      if (status === 'active') {
        setTabStatus(tabId, 'connected')
        requestAnimationFrame(() => {
          fitRef.current?.fit()
          if (termRef.current) emitResize(termRef.current)
          termRef.current?.focus()
          suppressInputRef.current = false
        })
      } else {
        suppressInputRef.current = false
        setTabStatus(tabId, 'disconnected')
      }
    }

    const onConnected = ({ tab_id }: { tab_id: string }) => {
      if (tab_id !== tabId) return
      errorRef.current = ''
      suppressInputRef.current = false
      setTabStatus(tabId, 'connected')
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        if (termRef.current) emitResize(termRef.current)
        termRef.current?.focus()
      })
    }

    const onError = ({ tab_id, message }: { tab_id: string; message: string }) => {
      if (tab_id !== tabId) return
      errorRef.current = message
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
      socket.off('session:restored', onRestored)
      socket.off('ssh:connected', onConnected)
      socket.off('ssh:error', onError)
      socket.off('ssh:closed', onClosed)
    }
  }, [socket, tabId, setTabStatus, emitResize])

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && tab?.status === 'connected') {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        if (termRef.current) emitResize(termRef.current)
        // In split mode, focused prop controls which pane gets keyboard focus
        if (focused ?? true) termRef.current?.focus()
      })
    }
  }, [isActive, focused, tab?.status, emitResize])

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
          error={tab?.status === 'dead' ? (errorRef.current || 'Connection closed.') : undefined}
          onConnect={handleConnect}
        />
      )}
    </div>
  )
}
