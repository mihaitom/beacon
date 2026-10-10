import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser's AudioSession, stubbed with a counting setter so a test can
// tell "declared once" from "asserted again on the gesture".
let sessionValue: string
let sessionTypes: string[]

function defineSession(): void {
  Object.defineProperty(navigator, 'audioSession', {
    configurable: true,
    value: {
      get type(): string {
        return sessionValue
      },
      set type(next: string) {
        sessionValue = next
        sessionTypes.push(next)
      },
    },
  })
}

async function start(): Promise<void> {
  vi.resetModules()
  const { initAudioSession } = await import('@/services/audioSession')
  initAudioSession()
}

beforeEach(() => {
  sessionValue = 'auto'
  sessionTypes = []
  defineSession()
})

afterEach(() => {
  // Any gesture listener still attached detaches itself on this, so it
  // cannot write into the next test's stub.
  window.dispatchEvent(new Event('click'))
  vi.restoreAllMocks()
})

describe('initAudioSession', () => {
  it('declares a playback session straight away', async () => {
    await start()

    expect(sessionValue).toBe('playback')
  })

  it('asserts it again on the first gesture, which is when Safari honours it', async () => {
    await start()
    sessionValue = 'auto'
    sessionTypes = []

    window.dispatchEvent(new Event('click'))

    expect(sessionTypes).toEqual(['playback'])
  })

  it('detaches after the first gesture', async () => {
    await start()
    window.dispatchEvent(new Event('click'))

    sessionValue = 'auto'
    sessionTypes = []
    window.dispatchEvent(new Event('click'))

    expect(sessionTypes).toEqual([])
  })

  it('is a no-op where the browser has no audioSession (Chromium, older Safari)', async () => {
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: undefined })

    await expect(start()).resolves.toBeUndefined()
  })

  it('initialises once, however often it is called', async () => {
    vi.resetModules()
    const { initAudioSession } = await import('@/services/audioSession')
    initAudioSession()

    sessionTypes = []
    initAudioSession()

    expect(sessionTypes).toEqual([])
  })
})
