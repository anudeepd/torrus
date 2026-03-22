export type TabStatus = 'disconnected' | 'connecting' | 'connected' | 'dead'

export interface Tab {
  id: string
  host: string | null
  port: number | null
  username: string | null
  label: string | null
  status: TabStatus
  sessionKey: string  // `${sessionId}:${tabId}` — used as Socket.IO room key
}

export interface ConnectFormValues {
  host: string
  port: number
  username: string
  password: string
}

export interface SavedServer {
  id: string
  name: string
  host: string
  port: number
  username: string
}

export interface TerminalSettings {
  scrollbackLines: number
  fontSize: number
}
