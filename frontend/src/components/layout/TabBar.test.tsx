import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import TabBar from './TabBar'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useTerminalStore } from '@/store/terminalStore'

describe('TabBar', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    useTerminalStore.setState({ tabs: [], activeTabId: null })
    useBroadcastStore.setState({ enabled: false, excludedTabIds: [] })
    useServerConfigStore.setState({ ldapEnabled: false })
  })

  it('prevents the right-button press from selecting tab text', () => {
    useTerminalStore.setState({
      tabs: [{
        id: 'tab-1',
        type: 'terminal',
        host: null,
        port: null,
        username: null,
        label: 'Production',
        status: 'disconnected',
        sessionKey: 'session-1:tab-1',
      }],
      activeTabId: 'tab-1',
    })

    render(
      <TabBar
        onAddTab={() => {}}
        onCloseTab={() => {}}
        onCloneTab={() => {}}
        onOpenSftpTab={() => {}}
        onDuplicateTab={() => {}}
        onCloseAllTabs={() => {}}
        onOpenSettings={() => {}}
        onOpenSplitPicker={() => {}}
        onOpenBroadcastPicker={() => {}}
        onExitSplit={() => {}}
        onSetActiveTab={() => {}}
        inSplitMode={false}
      />,
    )

    const tab = screen.getByRole('tab', { name: /production/i })
    expect(tab.parentElement).toHaveClass('select-none')
    expect(fireEvent.mouseDown(tab, { button: 2 })).toBe(false)
  })
})
