import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TabBar from './TabBar'
import { useBroadcastStore } from '@/store/broadcastStore'
import { useServerConfigStore } from '@/store/serverConfigStore'
import { useTerminalStore } from '@/store/terminalStore'

describe('TabBar', () => {

  afterEach(() => {
    cleanup()
    useTerminalStore.setState({ tabs: [], activeTabId: null })
    useBroadcastStore.setState({ enabled: false, excludedTabIds: [] })
    useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
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
  it('scrolls a clipped active tab, including its close button, fully into view', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
    useTerminalStore.setState({
      tabs: [
        { id: 'tab-1', type: 'terminal', host: null, port: null, username: null, label: 'Production 1', status: 'disconnected', sessionKey: 'session-1:tab-1' },
        { id: 'tab-2', type: 'terminal', host: null, port: null, username: null, label: 'Production 2', status: 'disconnected', sessionKey: 'session-1:tab-2' },
      ],
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
        onSetActiveTab={id => useTerminalStore.getState().setActiveTab(id)}
        inSplitMode={false}
      />,
    )

    const tabList = screen.getByRole('tablist')
    const tab = screen.getByRole('tab', { name: /production 2/i })
    const item = tab.parentElement!
    vi.spyOn(tabList, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 0, 100, 40))
    tabList.scrollLeft = 20

    act(() => fireEvent.click(tab))

    expect(tabList.scrollLeft).toBe(80)
    frame.mockRestore()
  })
  it('shows the admin console button only to admin users', () => {
    const props = {
      onAddTab: () => {},
      onCloseTab: () => {},
      onCloneTab: () => {},
      onOpenSftpTab: () => {},
      onDuplicateTab: () => {},
      onCloseAllTabs: () => {},
      onOpenSettings: () => {},
      onOpenAdmin: () => {},
      onOpenSplitPicker: () => {},
      onOpenBroadcastPicker: () => {},
      onExitSplit: () => {},
      onSetActiveTab: () => {},
      inSplitMode: false,
    }

    useServerConfigStore.setState({ ldapEnabled: true, isAdmin: false })
    const { unmount } = render(<TabBar {...props} />)
    expect(screen.queryByRole('button', { name: 'Admin console' })).not.toBeInTheDocument()

    unmount()
    useServerConfigStore.setState({ ldapEnabled: true, isAdmin: true })
    render(<TabBar {...props} />)
    expect(screen.getByRole('button', { name: 'Admin console' })).toBeInTheDocument()
  })
})

