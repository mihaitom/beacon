import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

const playback = reactive({
  currentSong: null as { id: string; title: string } | null,
  radioStation: null as { name: string } | null,
  duration: 0,
  localPosition: 0,
  isPlaying: false,
  playPrevious: vi.fn(),
  playNext: vi.fn(),
  seek: vi.fn(),
  togglePlay: vi.fn(),
})
let notify: () => void = () => {}

vi.mock('@/stores/playback', () => ({
  usePlaybackStore: () =>
    Object.assign(playback, {
      $subscribe: (callback: () => void) => {
        notify = callback
      },
    }),
}))
vi.mock('@/stores/radioMetadata', () => ({ useRadioMetadataStore: () => ({ nowPlaying: null }) }))
vi.mock('@/stores/library', () => ({
  useLibraryStore: () => ({ client: () => ({ coverArtUrl: () => null }) }),
}))

let now = 0
const setPositionState = vi.fn()

async function start(): Promise<void> {
  vi.resetModules()
  const { initMediaSession } = await import('@/services/mediaSession')
  initMediaSession()
}

function tick(seconds: number, position: number): void {
  now += seconds * 1000
  playback.localPosition = position
  notify()
}

beforeEach(() => {
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('MediaMetadata', class {})
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: { setActionHandler: vi.fn(), setPositionState, metadata: null, playbackState: 'none' },
  })
  Object.assign(playback, {
    currentSong: { id: 'a', title: 'A' },
    radioStation: null,
    duration: 240,
    localPosition: 0,
    isPlaying: true,
  })
  setPositionState.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lock-screen position', () => {
  it("tells the OS the track's length, which a transcode's element never reports", async () => {
    await start()

    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 240,
      position: 0,
      playbackRate: 1,
    })
  })

  it('leaves ordinary playback to the OS to extrapolate', async () => {
    await start()
    tick(1, 1)
    tick(1, 2)
    tick(0.25, 2.25)

    expect(setPositionState).toHaveBeenCalledTimes(1)
  })

  it('reports a seek', async () => {
    await start()
    tick(1, 90)

    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 240,
      position: 90,
      playbackRate: 1,
    })
  })

  it('reports pausing, so a paused position is not extrapolated onwards', async () => {
    await start()
    tick(1, 1)
    playback.isPlaying = false
    tick(0.5, 1.5)
    tick(5, 1.5)

    expect(setPositionState).toHaveBeenCalledTimes(2)
    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 240,
      position: 1.5,
      playbackRate: 1,
    })
  })

  it('reports the next track', async () => {
    await start()
    playback.currentSong = { id: 'b', title: 'B' }
    playback.duration = 180
    tick(0, 0)

    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 180,
      position: 0,
      playbackRate: 1,
    })
  })

  it('clears it for a station, which has no length', async () => {
    await start()
    playback.currentSong = null
    playback.radioStation = { name: 'Station' }
    notify()

    expect(setPositionState).toHaveBeenLastCalledWith()
  })

  it('keeps a position past the known length inside it, which the OS would reject', async () => {
    await start()
    tick(1, 245)

    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 240,
      position: 240,
      playbackRate: 1,
    })
  })

  it('does not break the other controls on a browser without it', async () => {
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: { setActionHandler: vi.fn(), metadata: null, playbackState: 'none' },
    })

    await expect(start()).resolves.toBeUndefined()
    expect(navigator.mediaSession.playbackState).toBe('playing')
  })
})
