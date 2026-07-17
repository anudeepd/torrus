import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ scrollbackLines: 1_000, fontSize: 10 })
  })

  it('resets terminal preferences to the readable default font size', () => {
    useSettingsStore.getState().reset()

    expect(useSettingsStore.getState()).toMatchObject({
      scrollbackLines: 10_000,
      fontSize: 16,
    })
  })
})
