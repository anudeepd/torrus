import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsDialog from './SettingsDialog'
import { useSettingsStore } from '@/store/settingsStore'

describe('SettingsDialog', () => {
  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ scrollbackLines: 10_000, fontSize: 16 })
  })

  it('writes a new scrollback depth to the settings store', () => {
    render(<SettingsDialog onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Scrollback lines'), { target: { value: '50000' } })

    expect(useSettingsStore.getState().scrollbackLines).toBe(50_000)
  })

  it('restores the defaults from the reset control', () => {
    useSettingsStore.setState({ scrollbackLines: 100_000, fontSize: 20 })
    render(<SettingsDialog onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    expect(useSettingsStore.getState().scrollbackLines).toBe(10_000)
    expect(useSettingsStore.getState().fontSize).toBe(16)
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<SettingsDialog onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
