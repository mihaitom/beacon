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
  fetchRadioTitleHistory: vi.fn().mockResolvedValue({ url: null, history: [] }),
  RADIO_TITLE_PAGE_SIZE: 200,
}))

/** Only the callback sinks matter here: init() assigns them, and these
 * tests then call them the way the real <audio> element's events would. */
interface WiredEngine {
  play: ReturnType<typeof vi.fn>
  playLive: ReturnType<typeof vi.fn>
  bufferedAhead: number
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
  onConnectionLost: (() => void) | null
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

/** The two arguments playLive() is handed for `streamUrl` in the default
 * (relayed) mode: Beacon's own relay URL with the station's own inside it,
 * and the option that follows from the same decision (see
 * startLocalRadio()). Spread into toHaveBeenCalledWith. Both are pinned in
 * full where they are the subject, in playback.transport.test.ts — here the
 * only question is which station is playing.
 */
function playingStation(streamUrl: string): [unknown, unknown] {
  return [expect.stringContaining(encodeURIComponent(streamUrl)), { holdsConnection: true }]
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
      playLive: vi.fn(),
      bufferedAhead: 0,
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
      onConnectionLost: null,
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

  it('opens with the queue drawer and the lyrics panel shut, whatever the last session left open', () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    drawers.queueDrawerOpen = true
    drawers.lyricsPanelOpen = true

    playback.init()

    expect(drawers.queueDrawerOpen).toBe(false)
    expect(drawers.lyricsPanelOpen).toBe(false)
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

    it('does not clamp a live station to whatever length the last track left', async () => {
      // Confirmed live 2026-09-06: duration 170 (a previous track's length)
      // and localPosition stuck at exactly 170, on a station a quarter of an
      // hour in, with the backend reporting elapsed correctly the whole
      // time. A station has no length to clamp against — and every route to
      // a playing station other than playRadioStation() leaves duration
      // alone, since none of them changes the station: pressing play on a
      // restored one, picking a cast target for one already playing, and
      // both hand-off paths. See the positionClamp getter.
      const playback = usePlaybackStore()
      playback.init()
      const connect = useConnectStore()
      const radio = { title: 'Chill FM', url: 'https://stream.example/chill' }
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: radio.url,
        homePageUrl: null,
      }
      playback.duration = 170

      connect.status = makeStatus({
        targets: [{ name: 'Living Room', type: 'sonos' }],
        streaming: true,
        elapsed: 900,
        radio,
      })
      await flushPromises()

      expect(playback.localPosition).toBeCloseTo(900, 0)
    })

    it('still clamps a track to its own length', async () => {
      // The clamp is not simply gone: a track really does end, and letting
      // the extrapolation run past that would report a position the audio
      // never reaches.
      const playback = usePlaybackStore()
      playback.init()
      const connect = useConnectStore()
      playback.setQueue([makeSong('a', { duration: 170 })], 0)
      playback.duration = 170

      connect.status = makeStatus({
        targets: [{ name: 'Living Room', type: 'sonos' }],
        streaming: true,
        elapsed: 900,
      })
      await flushPromises()

      expect(playback.localPosition).toBe(170)
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

  // The backend reads the station's tag at the live edge; this device is
  // playing out of a buffer handed to it as fast as the network allowed.
  // Announcing the next song while the previous one is still audible is
  // the visible half of that gap.
  describe('the now-playing tag against what is audible', () => {
    function playChillFm() {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      return playback
    }

    /** One poll cycle: the interval init() started, plus the fetch it
     * awaits. */
    async function poll() {
      await vi.advanceTimersByTimeAsync(8000)
      await flushPromises()
    }

    it('holds a new title back by what the element has buffered ahead', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1 }],
        bitrate: 128,
        codec: 'MP3',
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      // Not yet: those 15 seconds are still in the buffer, unheard.
      expect(playback.radioNowPlaying).toBeNull()
      // ...while what describes the station rather than a moment in it is
      // applied straight away.
      expect(playback.radioCodec).toBe('MP3')

      await vi.advanceTimersByTimeAsync(15_000)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })

    it('shows it straight away when nothing is buffered ahead', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })

    it("does not hold anything while casting, where the buffer is the speaker's", async () => {
      const playback = playChillFm()
      castTo()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })

    it('does not re-arm the hold on every poll reporting the same title', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 10
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      // The poll runs every 8s, so a 10s hold sees one more answer with the
      // same title before it lands. Re-arming on that would push the title
      // back for as long as the station keeps playing it.
      await poll()
      await poll()
      await vi.advanceTimersByTimeAsync(2500)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })

    it('asks for the whole first page, then only for what is newer', async () => {
      // Started for its side effects alone — this one watches the requests
      // rather than the store they land in.
      playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(undefined)

      await poll()

      // The entry it already holds, so the backend has nothing to repeat.
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(1000)
    })

    it('puts a delta on top of the log rather than replacing it', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - First',
        history: [{ title: 'Artist - First', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Second',
        history: [{ title: 'Artist - Second', at: 2000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      expect(playback.radioTitleLog.map((e) => e.title)).toEqual([
        'Artist - Second',
        'Artist - First',
      ])
    })

    it('keeps re-offering a held entry until it is actually applied', async () => {
      // A held title is not in the log, so `since` still names the entry
      // below it and the backend keeps handing the same one back. That is
      // what saves keeping a pending buffer of entries on this side.
      const playback = playChillFm()
      engine.bufferedAhead = 20
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Held',
        history: [{ title: 'Artist - Held', at: 2000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      expect(playback.radioTitleLog).toEqual([])
      await poll()
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(undefined)

      await vi.advanceTimersByTimeAsync(20_000)

      expect(playback.radioTitleLog.map((e) => e.title)).toEqual(['Artist - Held'])
    })

    it('never lets the same entry into the log twice', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      await poll()

      expect(playback.radioTitleLog).toHaveLength(1)
    })

    it('treats a short first page as the whole log, with nothing older to fetch', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(playback.radioTitleLogComplete).toBe(true)
    })

    it('leaves the door open for older pages when the first one is full', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track 0',
        history: Array.from({ length: 200 }, (_, i) => ({
          title: `Artist - Track ${i}`,
          at: 100_000 - i,
        })),
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(playback.radioTitleLogComplete).toBe(false)
    })

    it('drops a held title when the station changes under it', async () => {
      const playback = playChillFm()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      playback.radioStation = {
        id: 'r2',
        name: 'Other FM',
        streamUrl: 'https://stream.example/other',
        homePageUrl: null,
      }
      playback.radioNowPlaying = null
      await vi.advanceTimersByTimeAsync(15_000)

      expect(playback.radioNowPlaying).toBeNull()
    })
  })

  describe('paging back through the title log', () => {
    function playChillFm() {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.radioTitleLog = [
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ]
      return playback
    }

    it('appends the page before the oldest entry it holds', async () => {
      const playback = playChillFm()
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })

      await playback.loadOlderRadioTitles()

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledWith(2000)
      expect(playback.radioTitleLog.map((e) => e.title)).toEqual([
        'Artist - Newest',
        'Artist - Oldest held',
        'Artist - Older',
      ])
    })

    it('stops asking once a page comes back shorter than a full one', async () => {
      const playback = playChillFm()
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })

      await playback.loadOlderRadioTitles()
      expect(playback.radioTitleLogComplete).toBe(true)

      await playback.loadOlderRadioTitles()

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledTimes(1)
    })

    it('keeps going while a page comes back full', async () => {
      const playback = playChillFm()
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: Array.from({ length: 200 }, (_, i) => ({
          title: `Artist - Old ${i}`,
          at: 1000 - i,
        })),
      })

      await playback.loadOlderRadioTitles()

      expect(playback.radioTitleLogComplete).toBe(false)
    })

    it('never has two pages of the same log in flight at once', async () => {
      // The scroll handler fires on every scroll event and leans on this
      // rather than throttling itself - see RadioTitleLog.vue's onScroll().
      const playback = playChillFm()
      let resolvePage: (page: radioMetadata.RadioTitleHistoryPage) => void = () => {}
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => (resolvePage = resolve)),
      )

      const first = playback.loadOlderRadioTitles()
      await playback.loadOlderRadioTitles()
      resolvePage({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await first

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledTimes(1)
      expect(playback.radioTitleLog).toHaveLength(3)
    })

    it('throws away a page that arrives after the station has changed', async () => {
      const playback = playChillFm()
      let resolvePage: (page: radioMetadata.RadioTitleHistoryPage) => void = () => {}
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => (resolvePage = resolve)),
      )

      const pending = playback.loadOlderRadioTitles()
      playback.radioStation = {
        id: 'r2',
        name: 'Other FM',
        streamUrl: 'https://stream.example/other',
        homePageUrl: null,
      }
      playback.resetRadioTitleLog()
      resolvePage({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await pending

      expect(playback.radioTitleLog).toEqual([])
    })

    it('throws away a page the backend built for a different station', async () => {
      // Same window as the poll's own url check: this client is on the new
      // station while the backend, for a moment, still is not.
      const playback = playChillFm()
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/other',
        history: [{ title: 'Other FM - Older', at: 1000 }],
      })

      await playback.loadOlderRadioTitles()

      expect(playback.radioTitleLog).toHaveLength(2)
      // Nor does it count as having reached the beginning of this
      // station's log — the next scroll asks again.
      expect(playback.radioTitleLogComplete).toBe(false)
    })

    it('asks nothing at all when no station is playing', async () => {
      const playback = usePlaybackStore()

      await playback.loadOlderRadioTitles()

      expect(radioMetadata.fetchRadioTitleHistory).not.toHaveBeenCalled()
    })

    it('lets a failed page be retried by the next scroll', async () => {
      const playback = playChillFm()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockRejectedValueOnce(
        new Error('unreachable'),
      )

      await playback.loadOlderRadioTitles()

      expect(playback.radioTitleLogComplete).toBe(false)

      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await playback.loadOlderRadioTitles()

      expect(playback.radioTitleLog).toHaveLength(3)
    })
  })

  describe('radio connection lost', () => {
    function playChillFm() {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      return playback
    }

    it('offers a way back once the engine has stopped retrying a station', () => {
      const playback = playChillFm()

      engine.onConnectionLost?.()

      expect(playback.radioConnectionLost).toBe(true)
    })

    it('says nothing for a song, which has its own queue to fall back on', () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.setQueue([makeSong('a')], 0)

      engine.onConnectionLost?.()

      expect(playback.radioConnectionLost).toBe(false)
    })

    it('says nothing while casting, this element not being what is playing', () => {
      // The backend relay holds the station's connection then, and it never
      // stops retrying on its own (core/radio_relay.py) - so there is no
      // give-up state here for a button to answer.
      const playback = playChillFm()
      castTo()

      engine.onConnectionLost?.()

      expect(playback.radioConnectionLost).toBe(false)
    })

    it('restarts the live connection from the edge when the listener asks', () => {
      const playback = playChillFm()
      playback.radioConnectionLost = true

      playback.reconnectRadio()

      expect(engine.playLive).toHaveBeenCalledWith(
        ...playingStation('https://stream.example/chill'),
      )
      expect(playback.radioConnectionLost).toBe(false)
      expect(playback.isPlaying).toBe(true)
      // Shown as connecting straight away - a button that changes nothing
      // visible for several seconds reads as one that did not work.
      expect(playback.radioBuffering).toBe(true)
      // No separate now-playing watch: relayed is the default, and the
      // relay reads the station's ICY tag out of the fetch it already
      // holds (see startLocalRadio()). Direct mode is what still needs one
      // — covered by its own test.
      expect(radioMetadata.startRadioMetadataWatch).not.toHaveBeenCalled()
    })

    it('does nothing without a station to reconnect to', () => {
      const playback = usePlaybackStore()
      playback.init()

      playback.reconnectRadio()

      expect(engine.playLive).not.toHaveBeenCalled()
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

      expect(engine.playLive).toHaveBeenCalledWith(
        ...playingStation('https://stream.example/chill'),
      )
      // No separate now-playing watch: relayed is the default, and the
      // relay reads the station's ICY tag out of the fetch it already
      // holds (see startLocalRadio()). Direct mode is what still needs one
      // — covered by its own test.
      expect(radioMetadata.startRadioMetadataWatch).not.toHaveBeenCalled()
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
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1_757_000_000 }],
        bitrate: 320,
        codec: 'MP3',
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
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
        url: 'https://stream.example/chill',
        title: 'Old Artist - Old Track',
        history: [{ title: 'Old Artist - Old Track', at: 1_757_000_000 }],
        bitrate: 128,
        codec: 'AAC',
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await flushPromises()

      expect(playback.radioNowPlaying).toBeNull()
      // The log belongs to the station it came from just as much as the
      // title does — a stale one must not land under the new station.
      expect(playback.radioTitleLog).toEqual([])
    })

    /** The half of "which station is this about" that only the backend
     * knows. It switches stations on its own schedule — a relayed station
     * becomes current there once the player has opened the new stream and
     * the relay has connected — so a poll sent right after a switch is
     * answered, correctly, for the station before it. */
    it('drops an answer the backend was still building for the previous station', async () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r2',
        name: 'Jazz FM',
        streamUrl: 'https://stream.example/jazz',
        homePageUrl: null,
      }
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Old Artist - Old Track',
        history: [{ title: 'Old Artist - Old Track', at: 1_757_000_000 }],
        bitrate: 128,
        codec: 'AAC',
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await vi.advanceTimersByTimeAsync(8000)

      expect(playback.radioNowPlaying).toBeNull()
      // The one that made this worth fixing: applied once, it stayed —
      // every later poll only asks for what is newer than the newest entry
      // held, so nothing replaced it short of a reload.
      expect(playback.radioTitleLog).toEqual([])
      // What describes the station is that station's too.
      expect(playback.radioCodec).toBeNull()
    })

    it('still applies an answer from a connect too old to name the station', async () => {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: null,
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1_757_000_000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await vi.advanceTimersByTimeAsync(8000)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })
  })

  /** Without this the log arrives up to a poll interval late, and later
   * than that in the usual relayed case — the backend does not even know
   * which station is current until the player has opened the stream, so
   * the first answer after a click is normally for the station before it
   * and dropped. It read as "the log only shows up once the station is
   * buffered". */
  describe('catching up with the backend after a station starts', () => {
    function startChillFm() {
      const playback = usePlaybackStore()
      playback.init()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.startRadioMetadataCatchup()
      return playback
    }

    function metadataFor(url: string | null): radioMetadata.RadioMetadata {
      return {
        url,
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1_757_000_000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      }
    }

    it('asks straight away rather than waiting out the interval', async () => {
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue(
        metadataFor('https://stream.example/chill'),
      )
      const playback = startChillFm()
      await flushPromises()

      expect(playback.radioTitleLog).toHaveLength(1)
    })

    it('keeps asking every second until the backend has switched over', async () => {
      // The first two answers are still the previous station's, the way
      // they are until the relay for this one is up.
      vi.mocked(radioMetadata.fetchRadioMetadata)
        .mockResolvedValueOnce(metadataFor('https://stream.example/previous'))
        .mockResolvedValueOnce(metadataFor('https://stream.example/previous'))
        .mockResolvedValue(metadataFor('https://stream.example/chill'))
      const playback = startChillFm()

      await vi.advanceTimersByTimeAsync(2000)

      expect(playback.radioTitleLog).toHaveLength(1)
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenCalledTimes(3)
    })

    it('stops once an answer for this station has landed', async () => {
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue(
        metadataFor('https://stream.example/chill'),
      )
      startChillFm()
      await flushPromises()
      vi.mocked(radioMetadata.fetchRadioMetadata).mockClear()

      // Four seconds of the fast cadence, none of which happen — the 8s
      // interval owns the polling again.
      await vi.advanceTimersByTimeAsync(4000)

      expect(radioMetadata.fetchRadioMetadata).not.toHaveBeenCalled()
    })

    it('gives up on a station whose stream never comes up', async () => {
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue(
        metadataFor('https://stream.example/previous'),
      )
      startChillFm()

      await vi.advanceTimersByTimeAsync(60_000)

      // 20 tries plus the immediate one, and whatever the 8s interval
      // asked for in that minute — the point is that it is bounded rather
      // than one per second for as long as the station is on screen.
      expect(vi.mocked(radioMetadata.fetchRadioMetadata).mock.calls.length).toBeLessThan(30)
    })
  })
})
