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
  onReconnectStateChange: ((reconnecting: boolean) => void) | null
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
      onReconnectStateChange: null,
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

    it('never lets a status tick reading a little below the counter pull it backwards', async () => {
      // The backend slews a recalibrated position_offset in over two seconds
      // (connect/core/playback_clock.py), so a tick landing mid-slew reads
      // below the previous one — smoothed away by positionTracker, which
      // this must go through rather than writing status.elapsed straight to
      // the display. It used to do both, which showed the raw value for the
      // ~200ms until the smoothing interval overwrote it again: the seek
      // bar's counter (and the lyrics highlight following it) jumping back
      // and forth twice per tick.
      const playback = usePlaybackStore()
      playback.init()
      const connect = useConnectStore()
      const target = { name: 'Living Room', type: 'sonos' as const }

      connect.status = makeStatus({ targets: [target], streaming: true, elapsed: 30 })
      await flushPromises()
      const before = playback.localPosition
      expect(before).toBeCloseTo(30)

      connect.status = makeStatus({ targets: [target], streaming: true, elapsed: 29.5 })
      await flushPromises()

      expect(playback.localPosition).toBeGreaterThanOrEqual(before)
    })

    it('does not re-read a status payload the connect store merely touched again', async () => {
      // The handler runs on every mutation of that store and re-reads the
      // same `status` object — the device picker's own 4s poll produces one
      // such mutation after another while it is open. status.elapsed is a
      // snapshot from when the payload was built, so recording it again
      // later hands the tracker a position that has since fallen behind,
      // which past its smoothing window reads as a real rewind and pulls
      // the counter back.
      const playback = usePlaybackStore()
      playback.init()
      const connect = useConnectStore()
      connect.status = makeStatus({
        targets: [{ name: 'Living Room', type: 'sonos' }],
        streaming: true,
        elapsed: 30,
      })
      await flushPromises()

      // Three seconds of smoothing later — well past the 1.5s the tracker
      // is willing to treat as a correction rather than a real move.
      vi.advanceTimersByTime(3000)
      const smoothed = playback.localPosition
      expect(smoothed).toBeGreaterThan(32)

      connect.isScanning = true // an unrelated mutation, same payload
      await flushPromises()

      expect(playback.localPosition).toBeGreaterThanOrEqual(smoothed)
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

  describe('radio reconnect buffering', () => {
    it('shows buffering while a local radio stream is retrying a dropped connection', () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }

      engine.onReconnectStateChange?.(true)

      expect(playback.radioBuffering).toBe(true)

      engine.onReconnectStateChange?.(false)

      expect(playback.radioBuffering).toBe(false)
    })

    it('leaves a song reconnect silent, there being no station to report it for', () => {
      // Matches audioEngine.ts's own reconnectOnDrop() comment: a song's
      // reconnect stays quiet on purpose, so this callback firing for one
      // must not surface anything.
      const playback = usePlaybackStore()
      playback.init()
      playback.setQueue([makeSong('a')], 0)
      playback.radioBuffering = false

      engine.onReconnectStateChange?.(true)

      expect(playback.radioBuffering).toBe(false)
    })

    it('leaves the cast-reported buffering flag alone while casting', () => {
      // radioBuffering while casting is server-authoritative (the SSE
      // status tick, see playback.ts's own $subscribe handler) - the local
      // element is not even the thing making sound then, so its own
      // reconnects say nothing about whether the cast target is buffering.
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      castTo()
      playback.radioBuffering = true

      engine.onReconnectStateChange?.(false)

      expect(playback.radioBuffering).toBe(true)
    })
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

    it('clears a stale buffering flag, there being no cast target left to still be filling one', async () => {
      // The SSE handler that normally clears this stops updating it the
      // moment casting becomes inactive (see playback.ts's own
      // `!activeNow` early return) — without this, SeekBar.vue/
      // MobileTransportControls.vue keep showing "Buffering…" forever
      // despite local audio already playing.
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.radioBuffering = true

      await playback.handOffToLocalPlayback()

      expect(playback.radioBuffering).toBe(false)
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
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1_757_000_000 }],
        bitrate: 320,
        codec: 'MP3',
      })

      await vi.advanceTimersByTimeAsync(8000)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
      expect(playback.radioTitleLog).toEqual([{ title: 'Artist - Track', at: 1_757_000_000 }])
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
      let resolveFirst: (metadata: radioMetadata.RadioMetadata) => void = () => {}
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
      resolveFirst({
        title: 'Old Artist - Old Track',
        history: [{ title: 'Old Artist - Old Track', at: 1_757_000_000 }],
        bitrate: 128,
        codec: 'AAC',
      })
      await flushPromises()

      expect(playback.radioNowPlaying).toBeNull()
      // The log belongs to the station it came from just as much as the
      // title does — a stale one must not land under the new station.
      expect(playback.radioTitleLog).toEqual([])
    })
  })
})
