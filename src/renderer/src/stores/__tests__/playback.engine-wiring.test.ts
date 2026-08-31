import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { useDrawersStore } from '../drawers'
import { getAudioEngine } from '@/services/audioEngine'
import * as radioMetadata from '@/services/connect/radioMetadata'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
// Reaches for navigator.mediaSession, which jsdom has no implementation of
// — and what it wires is covered by services/mediaSession.ts's own tests.
vi.mock('@/services/mediaSession', () => ({ initMediaSession: vi.fn() }))
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
}))

/** Only the callback sinks matter here: init() assigns them, and these
 * tests then call them the way the real <audio> element's events would. */
interface WiredEngine {
  play: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  setReplayGain: ReturnType<typeof vi.fn>
  onTimeUpdate: ((position: number) => void) | null
  onEnded: (() => void) | null
  onError: ((message: string) => void) | null
  onDurationChange: ((duration: number) => void) | null
}

let engine: WiredEngine

function castTo(): void {
  useConnectStore().status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })
}

function stubLibraryClient(): void {
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
    scrobble: vi.fn().mockResolvedValue(undefined),
  } as unknown as SubsonicClient)
}

describe('the store wiring the audio engine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    engine = {
      play: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
      setReplayGain: vi.fn(),
      onTimeUpdate: null,
      onEnded: null,
      onError: null,
      onDurationChange: null,
    }
    vi.mocked(getAudioEngine).mockReturnValue(
      engine as unknown as ReturnType<typeof getAudioEngine>,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the element the restored volume rather than starting at full blast', () => {
    const playback = usePlaybackStore()
    playback.volume = 0.4

    playback.init()

    expect(engine.setVolume).toHaveBeenCalledWith(0.4)
  })

  it('opens with both drawers shut, whatever the last session left open', () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    drawers.queueDrawerOpen = true
    drawers.lyricsDrawerOpen = true

    playback.init()

    expect(drawers.queueDrawerOpen).toBe(false)
    expect(drawers.lyricsDrawerOpen).toBe(false)
  })

  it('wires the element up once, however often App.vue calls it', () => {
    const playback = usePlaybackStore()

    playback.init()
    playback.init()

    expect(engine.setVolume).toHaveBeenCalledOnce()
  })

  describe('position updates', () => {
    it('follows the element while it is the one playing', () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.setQueue([makeSong('a')], 0)

      engine.onTimeUpdate?.(12.5)

      expect(playback.localPosition).toBe(12.5)
    })

    it('registers the play once the element has been past the threshold', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.init()
      playback.setQueue([makeSong('scrobble-me', { duration: 100 })], 0)

      engine.onTimeUpdate?.(60)
      await flushPromises()

      expect(useLibraryStore().client().scrobble).toHaveBeenCalledWith('scrobble-me', true)
    })

    it('ignores the silent element while a speaker is the one playing', () => {
      // The position then comes from the connect status tick instead, which
      // is server-authoritative and calibrated for the device's buffering
      // delay — the local element is not even loaded.
      const playback = usePlaybackStore()
      playback.init()
      playback.setQueue([makeSong('a')], 0)
      castTo()
      playback.localPosition = 90

      engine.onTimeUpdate?.(3)

      expect(playback.localPosition).toBe(90)
    })
  })

  describe('duration', () => {
    it('takes the length the element measured', () => {
      const playback = usePlaybackStore()
      playback.init()

      engine.onDurationChange?.(212)

      expect(playback.duration).toBe(212)
    })

    it('keeps the cast session length while casting', () => {
      const playback = usePlaybackStore()
      playback.init()
      castTo()
      playback.duration = 300

      engine.onDurationChange?.(0)

      expect(playback.duration).toBe(300)
    })
  })

  describe('a track running out', () => {
    it('advances the queue when the element reports the end', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.init()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      engine.onEnded?.()
      await flushPromises()

      expect(playback.currentIndex).toBe(1)
    })

    it('leaves the advance to the cast session while casting', async () => {
      // connect drives its own auto-advance there; acting on both would
      // skip a song.
      const playback = usePlaybackStore()
      playback.init()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      castTo()

      engine.onEnded?.()
      await flushPromises()

      expect(playback.currentIndex).toBe(0)
    })
  })

  it('drops the playing state when the element reports a failure', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const playback = usePlaybackStore()
    playback.init()
    playback.isPlaying = true

    engine.onError?.('MEDIA_ELEMENT_ERROR: Format error')

    expect(playback.isPlaying).toBe(false)
    expect(logged).toHaveBeenCalled()
  })

  describe('handOffToLocalPlayback', () => {
    it('picks the song back up here, from where the speaker had got to', async () => {
      // The local element is never kept in sync while casting, so without
      // this it still points at whatever was loaded before the cast began.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.localPosition = 75
      playback.isPlaying = true

      await playback.handOffToLocalPlayback()

      expect(engine.play).toHaveBeenCalledWith('https://server.example/stream/b', 75, 1)
    })

    it('loads without playing when the cast session was paused', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a')], 0)
      playback.localPosition = 30
      playback.isPlaying = false

      await playback.handOffToLocalPlayback()

      expect(engine.load).toHaveBeenCalledWith('https://server.example/stream/a', 30, 1)
      expect(engine.play).not.toHaveBeenCalled()
    })

    it('reconnects a radio stream from the top, having no position to keep', async () => {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.isPlaying = true

      await playback.handOffToLocalPlayback()

      expect(engine.play).toHaveBeenCalledWith('https://stream.example/chill')
      // Local playback never otherwise reaches the connect backend at all
      // — see services/connect/radioMetadata.ts's own docstring.
      expect(radioMetadata.startRadioMetadataWatch).toHaveBeenCalledWith(
        'https://stream.example/chill',
      )
    })

    it('clears the offer to resume, there being no device left to resume on', async () => {
      const playback = usePlaybackStore()
      playback.castInterrupted = true

      await playback.handOffToLocalPlayback()

      expect(playback.castInterrupted).toBe(false)
    })

    it('has nothing to hand off with an empty queue', async () => {
      const playback = usePlaybackStore()

      await playback.handOffToLocalPlayback()

      expect(engine.play).not.toHaveBeenCalled()
      expect(engine.load).not.toHaveBeenCalled()
    })
  })

  describe('the radio now-playing poll', () => {
    it('picks up the backend-reported title while a station is playing', async () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue('Artist - Track')

      await vi.advanceTimersByTimeAsync(8000)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })

    it('never polls while nothing is playing', async () => {
      const playback = usePlaybackStore()
      playback.init()

      await vi.advanceTimersByTimeAsync(8000)

      expect(radioMetadata.fetchRadioMetadata).not.toHaveBeenCalled()
    })

    it('discards a stale answer for a station that has since changed', async () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      let resolveFirst: (title: string | null) => void = () => {}
      vi.mocked(radioMetadata.fetchRadioMetadata).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )

      await vi.advanceTimersByTimeAsync(8000)
      // The station changes while that poll is still in flight.
      playback.radioStation = {
        id: 'r2',
        name: 'Jazz FM',
        streamUrl: 'https://stream.example/jazz',
        homePageUrl: null,
      }
      resolveFirst('Old Artist - Old Track')
      await flushPromises()

      expect(playback.radioNowPlaying).toBeNull()
    })
  })
})
