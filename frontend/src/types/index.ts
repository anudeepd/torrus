export type TabStatus = 'disconnected' | 'connecting' | 'connected' | 'dead'
export type TabType = 'terminal' | 'sftp'

export interface Tab {
  id: string
  type: TabType
  host: string | null
  port: number | null
  username: string | null
  label: string | null
  status: TabStatus
  sessionKey: string  // `${sessionId}:${tabId}` — used as Socket.IO room key
  sourceTabId?: string
}

export interface SFTPEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink'
  is_symlink?: boolean
  size: number
  mtime: number
  mode?: number
  uid?: number
  gid?: number
  owner?: string
  group?: string
}

export interface SFTPUser {
  uid: number
  name: string
}

export interface SFTPGroup {
  gid: number
  name: string
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
