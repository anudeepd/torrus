import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createRoot = vi.hoisted(() => vi.fn(() => ({ render: vi.fn() })))
const installScrollbarFallback = vi.hoisted(() => vi.fn())
const installFocusModality = vi.hoisted(() => vi.fn())

vi.mock('react-dom/client', () => ({ createRoot }))
vi.mock('./App', () => ({ default: () => <div data-testid="app" /> }))
vi.mock('./utils/scrollbarFallback', () => ({ installScrollbarFallback }))
vi.mock('./utils/focusModality', () => ({ installFocusModality }))

describe('main entrypoint', () => {
  beforeEach(() => {
    vi.resetModules()
    createRoot.mockClear()
    installScrollbarFallback.mockClear()
    installFocusModality.mockClear()
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('installs browser polyfills and mounts the app under the strict motion runtime', async () => {
    await import('./main')

    expect(installScrollbarFallback).toHaveBeenCalledOnce()
    expect(installFocusModality).toHaveBeenCalledOnce()
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    const root = createRoot.mock.results[0].value
    expect(root.render).toHaveBeenCalledOnce()
  })
})
