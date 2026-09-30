/**
 * How far each terminal has got in its session's output stream.
 *
 * The server numbers every chunk of shell output by where it ends in the stream
 * and names the stream (one per SSH session). A browser whose socket dropped
 * reports that position when it registers again, so the server sends only the
 * bytes it missed instead of replaying its whole buffer into a terminal that
 * already shows it. Kept outside React state: it changes with every chunk, and
 * the xterm it describes outlives the pane that renders it.
 */
export interface StreamPosition {
  stream: string
  offset: number
}

const positions = new Map<string, StreamPosition>()

export function recordStreamPosition(tabId: string, position: StreamPosition): void {
  positions.set(tabId, position)
}

export function streamPosition(tabId: string): StreamPosition | undefined {
  return positions.get(tabId)
}

/** Forget a tab whose terminal is gone or new: it has drawn nothing of any stream. */
export function forgetStreamPosition(tabId: string): void {
  positions.delete(tabId)
}

/**
 * The `session:register` payload for a tab. A terminal that has drawn output
 * says where it stopped; a new tab, or a fresh page, sends none and receives
 * the server's whole replay buffer.
 */
export function sessionRegisterPayload(sessionId: string, tabId: string) {
  const resume = positions.get(tabId)
  return resume
    ? { session_id: sessionId, tab_id: tabId, resume }
    : { session_id: sessionId, tab_id: tabId }
}
