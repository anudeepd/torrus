import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronDown, ChevronUp, LoaderCircle, X } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { anchoredSurface, exitTransition, fade, surfaceSpring, surfaceTransition } from '@/motion/tokens'
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
const BACKWARD_KILL_WORD_SEQUENCE = `${ANSI_ESCAPE}\x7f`
const YANK_SEQUENCE = '\x19'
const SCROLLBACK_CLEAR_SEQUENCE = new RegExp(`${ANSI_ESCAPE}\\[[?]?(?:3J)`, 'g')
const TERMINAL_REPLY_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE}(?:\\[(?:\\?|>|!|=)?[0-9;]*[cRn]|\\][0-9;]*(?:;[^${ANSI_ESCAPE}\\x07]*)?(?:\\x07|${ANSI_ESCAPE}\\\\))`,
  'g'
)
const ANSI_OSC_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\][^\\x07]*(?:\\x07|${ANSI_ESCAPE}\\\\)`,
  'g',
)
const ANSI_CSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripTerminalFormatting(data: string): string {
  return data.replace(ANSI_OSC_PATTERN, '').replace(ANSI_CSI_PATTERN, '')
}

const SENSITIVE_PROMPT_PATTERN = /^(?:\[[^\]\r\n]*\]\s*)?(?:(?:enter|type|provide)\s+)?(?:sudo\s+)?(?:password|passphrase|passcode|pin|otp|one[- ]time password|verification code|security token|token|secret)(?:\s+for\b[^:\r\n]{0,80})?\s*[:?]\s*$/i

function isSensitivePrompt(data: string): boolean {
  const lastLine = stripTerminalFormatting(data).split(/[\r\n]/).pop()?.trim() ?? ''
  return lastLine.length > 0 && lastLine.length <= 160 && SENSITIVE_PROMPT_PATTERN.test(lastLine)
}

const RESTORE_INPUT_SUPPRESSION_MS = 800
const CONNECT_TIMEOUT_MS = 25_000

function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function bracketTextForPaste(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text
}

function stripScrollbackClearSequences(data: string): string {
  return data.replace(SCROLLBACK_CLEAR_SEQUENCE, '')
}

function trailingScrollbackClearPrefix(data: string): string {
  for (const prefix of [`${ANSI_ESCAPE}[?3`, `${ANSI_ESCAPE}[3`, `${ANSI_ESCAPE}[?`, `${ANSI_ESCAPE}[`, ANSI_ESCAPE]) {
    if (data.endsWith(prefix)) return prefix
  }
  return ''
}

function preserveVisibleRows(term: Terminal, onPreserved: () => void): void {
  const visibleLines = Math.min(term.rows, term.buffer.active.cursorY + 1)
  if (visibleLines <= 0) {
    onPreserved()
    return
  }

  // Readline clears the viewport in place with CSI J, so those rows never
  // enter xterm's scrollback naturally. Scroll only the used rows off-screen
  // before forwarding Ctrl+L. Save/restore the cursor and wait for xterm to
  // finish parsing this sequence so the shell and renderer cannot race.
  term.scrollToBottom()
  term.write(
    `${ANSI_ESCAPE}[s${ANSI_ESCAPE}[${term.rows};1H${`${ANSI_ESCAPE}D`.repeat(visibleLines)}${ANSI_ESCAPE}[u`,
    onPreserved,
  )
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
  searchAddon: SearchAddon
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
  const findInputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const errorRef = useRef<string>('')
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  // Ctrl+L clears the visible screen, not the user's history. Some shells
  // emit CSI 3 J asynchronously, so suppress exactly the next such sequence
  // rather than relying on an arbitrary timing window.
  const suppressNextScrollbackClearRef = useRef(false)
  const pendingScrollbackClearPrefixRef = useRef('')
  const [connectionError, setConnectionError] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<boolean | null>(null)
  // Suppress xterm onData during session restore to prevent terminal query
  // responses (OSC 11, DSR, DA) from being echoed back to the remote shell
  const sensitiveInputPendingRef = useRef(false)
  const sensitiveOutputTailRef = useRef('')
  const suppressInputRef = useRef(false)
  const suppressInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const noteSensitivePrompt = useCallback((output: string) => {
    const visible = stripTerminalFormatting(output)
    sensitiveOutputTailRef.current = `${sensitiveOutputTailRef.current}${visible}`.slice(-200)
    if (isSensitivePrompt(sensitiveOutputTailRef.current)) {
      sensitiveInputPendingRef.current = true
    }
  }, [])
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current)
    connectTimeoutRef.current = null
  }, [])

  const emitInput = useCallback((data: string) => {
    if (suppressInputRef.current) return
    if (isTerminalReplyOnly(data)) return

    if (suppressNextScrollbackClearRef.current && data !== '\x0c') {
      if (pendingScrollbackClearPrefixRef.current) {
        termRef.current?.write(pendingScrollbackClearPrefixRef.current)
        pendingScrollbackClearPrefixRef.current = ''
      }
      suppressNextScrollbackClearRef.current = false
    }

    const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (currentTab?.status !== 'connected') return

    const sensitive = sensitiveInputPendingRef.current
    const payload = sensitive
      ? { session_id: sessionId, tab_id: tabId, data, sensitive: true }
      : { session_id: sessionId, tab_id: tabId, data }
    const { enabled } = useBroadcastStore.getState()

    if (enabled && hasFocusRef.current && broadcastTargetIdsRef.current.size > 0) {
      for (const targetTabId of broadcastTargetIdsRef.current) {
        if (targetTabId !== tabId) {
          socket.emit('ssh:input', { ...payload, tab_id: targetTabId })
        }
      }
    }
    socket.emit('ssh:input', payload)
    if (sensitive && /[\r\n]/.test(data)) {
      sensitiveInputPendingRef.current = false
    }
  }, [tabId, socket, sessionId])
  const emitInterrupt = useCallback(() => {
    if (suppressInputRef.current) return
    const currentTab = useTerminalStore.getState().tabs.find(t => t.id === tabId)
    if (currentTab?.status !== 'connected') return
    const { enabled } = useBroadcastStore.getState()
    if (enabled && hasFocusRef.current && broadcastTargetIdsRef.current.size > 0) {
      for (const targetTabId of broadcastTargetIdsRef.current) {
        if (targetTabId !== tabId) {
          socket.emit('ssh:interrupt', { session_id: sessionId, tab_id: targetTabId })
        }
      }
    }
    socket.emit('ssh:interrupt', { session_id: sessionId, tab_id: tabId })
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
      const deletePreviousWord =
        e.type === 'keydown'
        && key === 'backspace'
        && !e.metaKey
        && !e.shiftKey
        && ((e.altKey && !e.ctrlKey) || (e.ctrlKey && !e.altKey))
      if (deletePreviousWord) {
        emitInput(BACKWARD_KILL_WORD_SEQUENCE)
        e.preventDefault()
        return false
      }
      if (
        e.type === 'keydown'
        && e.ctrlKey
        && !e.metaKey
        && !e.altKey
        && !e.shiftKey
        && key === 'y'
      ) {
        emitInput(YANK_SEQUENCE)
        e.preventDefault()
        return false
      }
      if (
        e.type === 'keydown'
        && e.repeat
        && e.key.length === 1
        && !e.isComposing
        && !e.ctrlKey
        && !e.metaKey
        && !e.altKey
      ) {
        term.input(e.key, true)
        e.preventDefault()
        return false
      }
      if (mod && (key === 'w' || key === 't' || key === ',')) return false
      if (e.ctrlKey && key === 'tab') return false
      if (mod && key === 'f') {
        e.preventDefault()
        setFindOpen(true)
        return false
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'c') {
        if (term.hasSelection()) return false
        emitInterrupt()
        return false
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'l') {
        suppressNextScrollbackClearRef.current = true
        preserveVisibleRows(term, () => emitInput('\x0c'))
        return false
      }
      if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && key === 'c' && term.hasSelection()) return false
      if (mod && key === 'v') return false
      return true
    })
  }, [emitInput, emitInterrupt])

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
        const searchAddon = new SearchAddon()
        const webLinksAddon = new WebLinksAddon((event: MouseEvent, uri: string) => {
          if (uri.startsWith('javascript:') || uri.startsWith('data:') || uri.startsWith('vbscript:')) {
            event.preventDefault()
            return
          }
          window.open(uri, '_blank', 'noopener,noreferrer')
        })
        term.loadAddon(fitAddon)
        term.loadAddon(searchAddon)
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
        terminalCache.set(tabId, { term, fitAddon, searchAddon, container: termContainer })

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

  const getSearchAddon = useCallback(() => terminalCache.get(tabId)?.searchAddon, [tabId])

  const search = useCallback((direction: 'next' | 'previous', query = findQuery) => {
    if (!query) {
      setFindResult(null)
      return
    }
    const searchAddon = getSearchAddon()
    const found = direction === 'next'
      ? searchAddon?.findNext(query, { incremental: true })
      : searchAddon?.findPrevious(query)
    setFindResult(found ?? false)
  }, [findQuery, getSearchAddon])

  useEffect(() => {
    if (!findOpen) return
    const frame = requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [findOpen])

  const closeFind = useCallback(() => {
    getSearchAddon()?.clearDecorations()
    setFindOpen(false)
    setFindQuery('')
    setFindResult(null)
    termRef.current?.focus()
  }, [getSearchAddon])

  // Browser Find can win before xterm receives a key event, especially after
  // the terminal loses its hidden textarea focus. Capture it at the window so
  // the focused pane always searches the complete xterm scrollback buffer.
  useEffect(() => {
    if (!isActive || focused === false || tab?.status !== 'connected') return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isActive, focused, tab?.status])

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
      if (useTerminalStore.getState().tabs.find(tab => tab.id === tabId)?.status === 'connecting') {
        setTabStatus(tabId, 'connected')
      }
      const stripCtrlLClear = (output: string): string | undefined => {
        if (!suppressNextScrollbackClearRef.current) return undefined
        const pendingPrefix = pendingScrollbackClearPrefixRef.current
        const combined = pendingPrefix + output
        pendingScrollbackClearPrefixRef.current = ''
        const preserved = stripScrollbackClearSequences(combined)
        if (preserved !== combined) {
          suppressNextScrollbackClearRef.current = false
          return preserved
        }
        const trailingPrefix = trailingScrollbackClearPrefix(combined)
        if (trailingPrefix) {
          pendingScrollbackClearPrefixRef.current = trailingPrefix
          return combined.slice(0, -trailingPrefix.length)
        }
        // A partial escape sequence from the preceding socket frame did not
        // become a scrollback-clear command. Write the complete sequence.
        return pendingPrefix ? combined : undefined
      }
      if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        const output = new TextDecoder().decode(bytes)
        noteSensitivePrompt(output)
        termRef.current.write(stripCtrlLClear(output) ?? bytes)
      } else if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data)
        const output = new TextDecoder().decode(bytes)
        noteSensitivePrompt(output)
        termRef.current.write(stripCtrlLClear(output) ?? bytes)
      } else if (typeof data === 'string') {
        noteSensitivePrompt(data)
        termRef.current.write(stripCtrlLClear(data) ?? data)
      } else {
        console.warn('Received unexpected data type from ssh:output:', typeof data)
      }
    }
    socket.on('ssh:output', onOutput)
    return () => { socket.off('ssh:output', onOutput) }
  }, [socket, tabId, setTabStatus, noteSensitivePrompt])

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
      clearConnectTimeout()
      errorRef.current = ''
      setConnectionError('')
      setTabStatus(tabId, 'connected')
      sensitiveInputPendingRef.current = false
      sensitiveOutputTailRef.current = ''
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
      clearConnectTimeout()
      errorRef.current = message
      setConnectionError(message)
      sensitiveInputPendingRef.current = false
      sensitiveOutputTailRef.current = ''
      setTabStatus(tabId, 'dead')
    }

    const onClosed = ({ tab_id, reason }: { tab_id: string; reason: string }) => {
      if (tab_id !== tabId) return
      clearConnectTimeout()
      sensitiveInputPendingRef.current = false
      sensitiveOutputTailRef.current = ''
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
      clearConnectTimeout()
      socket.off('session:restored', onRestored)
      socket.off('ssh:connected', onConnected)
      socket.off('ssh:error', onError)
      socket.off('ssh:closed', onClosed)
    }
  }, [socket, tabId, setTabStatus, fitAndEmitResize, suppressRestoreInputBriefly, clearConnectTimeout])

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
    clearConnectTimeout()
    errorRef.current = ''
    setConnectionError('')
    sensitiveInputPendingRef.current = false
    sensitiveOutputTailRef.current = ''
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
    connectTimeoutRef.current = setTimeout(() => {
      connectTimeoutRef.current = null
      if (useTerminalStore.getState().tabs.find(tab => tab.id === tabId)?.status !== 'connecting') return
      const message = 'Connection timed out. Check host, port, and network access.'
      errorRef.current = message
      setConnectionError(message)
      suppressInputRef.current = true
      setTabStatus(tabId, 'dead')
    }, CONNECT_TIMEOUT_MS)
  }, [socket, sessionId, tabId, setTabStatus, setTabConnection, clearConnectTimeout])

  const showForm = !tab || tab.status === 'disconnected' || tab.status === 'dead'
  const isConnecting = tab?.status === 'connecting'

  return (
    <div className="relative w-full h-full">
      {/* xterm.js container — always mounted so the terminal persists */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ display: showForm ? 'none' : 'block' }}
      />

      <AnimatePresence initial={false}>
        {isConnecting && (
          <m.div
            key="connecting"
            {...fade}
            transition={surfaceTransition}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <m.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, transition: exitTransition }}
              transition={surfaceSpring}
              className="flex items-center gap-3 rounded-xl border border-surface-700 bg-surface-900/95 px-5 py-4 text-sm text-slate-300 shadow-2xl"
            >
              <LoaderCircle className="h-4 w-4 animate-spin text-brand-400" />
              <span>Connecting to {tab?.host || 'host'}…</span>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
      {findOpen && (
        <m.div {...anchoredSurface} transition={surfaceSpring} className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-surface-700 bg-surface-900/95 p-1.5 shadow-xl backdrop-blur" role="search" aria-label="Find in terminal">
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={event => {
              const query = event.target.value
              setFindQuery(query)
              search('next', query)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') closeFind()
              if (event.key === 'Enter') {
                event.preventDefault()
                search(event.shiftKey ? 'previous' : 'next')
              }
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            className="h-7 w-44 rounded bg-surface-950 px-2 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-brand-500"
          />
          {findQuery && findResult === false && <span className="px-1 text-[10px] text-amber-400">No match</span>}
          <button type="button" onClick={() => search('previous')} title="Previous match" aria-label="Previous match" className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => search('next')} title="Next match" aria-label="Next match" className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={closeFind} title="Close find" aria-label="Close find" className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200">
            <X className="h-3.5 w-3.5" />
          </button>
        </m.div>
      )}
      </AnimatePresence>

      {/* Connection form overlay */}
      <AnimatePresence initial={false}>
        {showForm && (
          <m.div
            key="connection-form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: exitTransition }}
            transition={surfaceTransition}
            className="absolute inset-0 z-10"
          >
            <ConnectForm
              initialHost={tab?.host ?? undefined}
              initialPort={tab?.port ?? undefined}
              initialUsername={tab?.username ?? undefined}
              error={tab?.status === 'dead' ? (connectionError || 'Connection closed.') : undefined}
              onConnect={handleConnect}
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
