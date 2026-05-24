import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useTerminalStore } from '@/store/terminalStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useBroadcastStore } from '@/store/broadcastStore'
import { createMockSocket } from '@/test/mocks/socket'
import { mockTerminalInstances, clearMockTerminalInstances } from '@/test/mocks/xterm'
import TerminalPane from './TerminalPane'

function seedStores(tabId: string, status: 'connected' | 'disconnected') {
  useTerminalStore.setState({
    sessionId: 'test-session',
    tabs: [
      {
        id: tabId,
        host: 'localhost',
        port: 22,
        username: 'test',
        label: null,
        status,
        sessionKey: `test-session:${tabId}`,
      },
    ],
    activeTabId: tabId,
  })

  useSettingsStore.setState({
    scrollbackLines: 10000,
    fontSize: 14,
  })

  useBroadcastStore.setState({
    enabled: false,
    excludedTabIds: [],
  })
}

describe('TerminalPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMockTerminalInstances()
  })

  afterEach(() => {
    useTerminalStore.setState({ sessionId: '', tabs: [], activeTabId: null })
  })

  it('remains interactive when remounted with an already-connected tab (split-exit regression)', async () => {
    const tabId = 'tab-1'
    seedStores(tabId, 'connected')

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    expect(term.textarea).toBeInTheDocument()

    term.simulateData('hello')

    expect(socket.emit).toHaveBeenCalledWith(
      'ssh:input',
      expect.objectContaining({
        session_id: 'test-session',
        tab_id: tabId,
        data: 'hello',
      })
    )
  })

  it('suppresses input when mounted with a disconnected tab', async () => {
    const tabId = 'tab-2'
    seedStores(tabId, 'disconnected')

    const socket = createMockSocket()
    render(
      <TerminalPane
        tabId={tabId}
        isActive={true}
        focused={true}
        socket={socket as unknown as import('socket.io-client').Socket}
      />
    )

    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0)
    })

    const term = mockTerminalInstances[mockTerminalInstances.length - 1]
    term.simulateData('hello')

    expect(socket.emit).not.toHaveBeenCalledWith(
      'ssh:input',
      expect.anything()
    )
  })
})
