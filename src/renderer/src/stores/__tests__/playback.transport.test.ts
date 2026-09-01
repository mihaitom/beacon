import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { useRadioSettingsStore } from '../radioSettings'
import { getAudioEngine } from '@/services/audioEngine'
import * as connectPlayback from '@/services/connect/playback'
import * as radioMetadata from '@/services/connect/radioMetadata'
import { resolveRadioStreamUrl } from '@/services/connect/radio'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
}))

// Only resolveRadioStreamUrl is used from here; the rest of the module
// (radioFaviconUrl) stays real, same pattern as connect/playback below.
vi.mock('@/services/connect/radio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/radio')>()
  return { ...actual, resolveRadioStreamUrl: vi.fn() }
})

// Everything the transport actions dispatch to a cast session. The rest of
// the module stays real so useConnectStore()'s own imports keep working —
// same pattern as playback.clear-queue.test.ts.
vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return {
    ...actual,
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    playUrl: vi.fn(),
    updateQueue: vi.fn(),
  }
})

/** The shared <audio> wrapper, stubbed down to what the store actually
 * drives — see services/__tests__/audioEngine.test.ts for the engine's own
 * behaviour. */
function fakeEngine(): {
  play: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  seek: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  setReplayGain: ReturnType<typeof vi.fn>
  hasEnded: boolean
  isPaused: boolean
} {
  return {
    play: vi.fn(),
    load: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setReplayGain: vi.fn(),
    hasEnded: false,
    isPaused: true,
  }
}

let engine: ReturnType<typeof fakeEngine>

/** Casting is decided by the connect store reporting at least one target
 * (see its isActive getter), so this is all it takes to put the store on
 * the cast side of every branch below. */
function castTo(overrides: Parameters<typeof makeStatus>[0] = {}): void {
  useConnectStore().status = makeStatus({
    targets: [{ name: 'Living Room', type: 'sonos' }],
    ...overrides,
  })
}

function stubLibraryClient(): { streamUrl: ReturnType<typeof vi.fn> } {
  const client = {
    streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
    scrobble: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

describe('playback transport', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    engine = fakeEngine()
    vi.mocked(getAudioEngine).mockReturnValue(
      engine as unknown as ReturnType<typeof getAudioEngine>,
    )
    vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'playing' })
    vi.mocked(connectPlayback.pause).mockResolvedValue(undefined)
    vi.mocked(connectPlayback.resume).mockResolvedValue(undefined)
    vi.mocked(connectPlayback.seek).mockResolvedValue(undefined)
    vi.mocked(connectPlayback.stop).mockResolvedValue(undefined)
    vi.mocked(connectPlayback.playUrl).mockResolvedValue({ status: 'playing' })
    vi.mocked(connectPlayback.updateQueue).mockResolvedValue({ status: 'ok' })
    // Pass-through by default — the overwhelmingly common case, and what
    // the real thing does for any URL that isn't a playlist file.
    vi.mocked(resolveRadioStreamUrl).mockImplementation(async (url) => url)
  })

  describe('nextIndex', () => {
    it('walks the queue in both directions', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 1)

      expect(playback.nextIndex(1)).toBe(2)
      expect(playback.nextIndex(-1)).toBe(0)
    })

    it('reports nowhere to go at either end of a non-repeating queue', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      expect(playback.nextIndex(1)).toBeNull()

      playback.currentIndex = 0
      expect(playback.nextIndex(-1)).toBeNull()
    })

    it('wraps around both ends under repeat-all', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.repeatMode = 'all'

      expect(playback.nextIndex(1)).toBe(0)

      playback.currentIndex = 0
      expect(playback.nextIndex(-1)).toBe(1)
    })

    it('leaves currentIndex untouched — committing it is switchToIndex()s job', () => {
      // It used to move here, which let the UI jump to a song a failed
      // dispatch never actually started.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      playback.nextIndex(1)

      expect(playback.currentIndex).toBe(0)
    })
  })

  describe('togglePlay, playing locally', () => {
    it('pauses the element and says so right away', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true

      await playback.togglePlay()

      expect(engine.pause).toHaveBeenCalledOnce()
      expect(playback.isPlaying).toBe(false)
    })

    it('resumes the loaded element rather than re-fetching the song', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = false

      await playback.togglePlay()

      expect(engine.resume).toHaveBeenCalledOnce()
      expect(engine.play).not.toHaveBeenCalled()
      expect(playback.isPlaying).toBe(true)
    })

    it('restarts a track that already played to the end, which resume() cannot', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = false
      engine.hasEnded = true

      await playback.togglePlay()

      expect(engine.resume).not.toHaveBeenCalled()
      expect(engine.play).toHaveBeenCalledWith('https://server.example/stream/a', 0, 1)
      expect(playback.isPlaying).toBe(true)
    })
  })

  describe('togglePlay, casting', () => {
    it('waits for the device instead of claiming the new state itself', async () => {
      // isPlaying is left to the next SSE status tick here — the device is
      // the authority on whether it actually paused.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true
      castTo()

      await playback.togglePlay()

      expect(connectPlayback.pause).toHaveBeenCalledOnce()
      expect(playback.isPlaying).toBe(true)
    })

    it('resumes a paused session', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = false
      castTo({ paused: true })

      await playback.togglePlay()

      expect(connectPlayback.resume).toHaveBeenCalledOnce()
    })

    it('restarts a session whose stream already ran out, which resume() cannot', async () => {
      // The backend-side twin of the ended-<audio> case: a bare resume
      // leaves the position frozen, so the visualizer and lyrics feeds get
      // nothing to work from either.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = false
      castTo({ ended: true })

      await playback.togglePlay()

      expect(connectPlayback.resume).not.toHaveBeenCalled()
      expect(connectPlayback.play).toHaveBeenCalledWith('a', expect.anything())
    })

    it('ignores a second press while the first is still in flight', async () => {
      // Observed live as two /pause calls 66ms apart with no /resume
      // between: isPlaying only moves on the next status tick, so an
      // unguarded second press reads the same stale value and repeats the
      // same command — each one forcing a real device reconnect.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true
      castTo()
      let releaseFirstPause = (): void => {}
      vi.mocked(connectPlayback.pause).mockReturnValue(
        new Promise<void>((resolve) => {
          releaseFirstPause = resolve
        }),
      )

      const first = playback.togglePlay()
      await playback.togglePlay()

      expect(connectPlayback.pause).toHaveBeenCalledOnce()

      releaseFirstPause()
      await first
    })
  })

  describe('switchToIndex', () => {
    it('keeps the new song once the dispatch actually succeeded', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      await playback.switchToIndex(1)

      expect(playback.currentIndex).toBe(1)
      expect(playback.isPlaying).toBe(true)
      expect(engine.play).toHaveBeenCalledWith('https://server.example/stream/b', 0, 1)
    })

    it('rolls back to the song that is still playing when the dispatch fails', async () => {
      // Otherwise the UI keeps showing "now playing" for a song the cast
      // target never started, while it is audibly still on the old one.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      castTo()
      vi.mocked(connectPlayback.play).mockRejectedValue(new Error('device unreachable'))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      await playback.switchToIndex(1)

      expect(playback.currentIndex).toBe(0)
      expect(playback.isPlaying).toBe(false)
    })

    it('rolls back just the same when another client won the dispatch', async () => {
      // 'superseded' means nothing started here either — whichever client
      // actually won reports the truth on the next status tick.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      castTo()
      vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'superseded' })

      await playback.switchToIndex(1)

      expect(playback.currentIndex).toBe(0)
    })

    it('stays paused when the transport buttons move through a paused queue', async () => {
      // startCurrent() has no "load paused" mode, so navigating while
      // paused has to pause again afterwards rather than silently starting
      // playback the user deliberately stopped.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      playback.isPlaying = false

      await playback.switchToIndex(1, true)

      expect(playback.currentIndex).toBe(1)
      expect(engine.pause).toHaveBeenCalledOnce()
      expect(playback.isPlaying).toBe(false)
    })

    it('plays right away when a song is picked out of the queue by hand', async () => {
      // playAtIndex() deliberately doesn't preserve the pause: clicking a
      // song reads as "play this now", not "load this".
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      playback.isPlaying = false

      await playback.playAtIndex(1)

      expect(playback.currentIndex).toBe(1)
      expect(engine.pause).not.toHaveBeenCalled()
      expect(playback.isPlaying).toBe(true)
    })

    it('ignores an index outside the queue', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)

      await playback.playAtIndex(5)
      await playback.playAtIndex(-1)

      expect(playback.currentIndex).toBe(0)
      expect(engine.play).not.toHaveBeenCalled()
    })
  })

  describe('playNext / playPrevious', () => {
    it('stops at the end of a queue with nothing left to play', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.isPlaying = true

      await playback.playNext()

      expect(playback.currentIndex).toBe(1)
      expect(playback.isPlaying).toBe(false)
    })

    it('skips past the current song even with repeat-one on', async () => {
      // Repeat-one only replays a song that ended by itself — a press of
      // Next is an explicit "done with this one", as in every other player.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      playback.repeatMode = 'one'

      await playback.playNext()

      expect(playback.currentIndex).toBe(1)
    })

    it('has no queue to advance while a radio station is playing', async () => {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }

      await playback.playNext()
      await playback.playPrevious()

      expect(engine.play).not.toHaveBeenCalled()
    })

    it('restarts the current song once you are a few seconds into it', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.localPosition = 10

      await playback.playPrevious()

      expect(playback.currentIndex).toBe(1)
      expect(engine.play).toHaveBeenCalledWith('https://server.example/stream/b', 0, 1)
    })

    it('goes back a song when pressed early on, not just in the first second', async () => {
      // Reacting to a track change takes a moment; the window has to be
      // wide enough that the correction lands on the song you meant.
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.localPosition = 4

      await playback.playPrevious()

      expect(playback.currentIndex).toBe(0)
    })

    it('restarts the first song rather than doing nothing at the top of a queue', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      playback.localPosition = 1

      await playback.playPrevious()

      expect(playback.currentIndex).toBe(0)
      expect(engine.play).toHaveBeenCalledOnce()
    })
  })

  describe('advanceOnSongEnd', () => {
    it('replays the same song under repeat-one', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      playback.repeatMode = 'one'

      await playback.advanceOnSongEnd()

      expect(playback.currentIndex).toBe(0)
      expect(engine.play).toHaveBeenCalledWith('https://server.example/stream/a', 0, 1)
    })

    it('moves on to the next song otherwise', async () => {
      const playback = usePlaybackStore()
      stubLibraryClient()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      await playback.advanceOnSongEnd()

      expect(playback.currentIndex).toBe(1)
    })

    it('lets a radio stream end without touching the queue', async () => {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }

      await playback.advanceOnSongEnd()

      expect(engine.play).not.toHaveBeenCalled()
    })
  })

  describe('seek', () => {
    it('moves the local element and the position shown for it', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)

      await playback.seek(42)

      expect(engine.seek).toHaveBeenCalledWith(42)
      expect(playback.localPosition).toBe(42)
    })

    it('sends the seek to the device it is casting to', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      castTo()

      await playback.seek(42)

      expect(connectPlayback.seek).toHaveBeenCalledWith(42)
      expect(engine.seek).not.toHaveBeenCalled()
      expect(playback.localPosition).toBe(42)
    })
  })

  describe('stop', () => {
    it('stops the local element and forgets the position', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true
      playback.localPosition = 30

      await playback.stop()

      expect(engine.stop).toHaveBeenCalledOnce()
      expect(playback.isPlaying).toBe(false)
      expect(playback.localPosition).toBe(0)
    })

    it('stops the cast session instead while casting', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true
      castTo()

      await playback.stop()

      expect(connectPlayback.stop).toHaveBeenCalledOnce()
      expect(engine.stop).not.toHaveBeenCalled()
      expect(playback.isPlaying).toBe(false)
    })

    it('stops the radio-metadata watch when stopping local radio playback', async () => {
      const playback = usePlaybackStore()
      await playback.playRadioStation({
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })

      await playback.stop()

      expect(radioMetadata.stopRadioMetadataWatch).toHaveBeenCalledOnce()
      expect(playback.radioNowPlaying).toBeNull()
    })

    it("leaves the radio-metadata watch to the backend's own /stop while casting", async () => {
      const playback = usePlaybackStore()
      castTo()
      await playback.playRadioStation({
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })
      vi.mocked(radioMetadata.stopRadioMetadataWatch).mockClear()

      await playback.stop()

      // /play-url already started it server-side (see routes/playback.py) —
      // connectPlayback.stop() (mocked above) is what tells the backend's
      // own /stop to tear it back down, not a second call from here.
      expect(radioMetadata.stopRadioMetadataWatch).not.toHaveBeenCalled()
    })

    it('does not call stopRadioMetadataWatch when no radio was playing', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)

      await playback.stop()

      expect(radioMetadata.stopRadioMetadataWatch).not.toHaveBeenCalled()
    })
  })

  describe('radio', () => {
    it('clears the queue it cannot advance and plays the stream', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      const station = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }

      await playback.playRadioStation(station)

      expect(playback.queue).toEqual([])
      expect(playback.currentIndex).toBe(-1)
      expect(playback.radioStation).toEqual(station)
      expect(engine.play).toHaveBeenCalledWith('https://stream.example/chill')
      expect(playback.isPlaying).toBe(true)
      // Local playback never otherwise reaches the connect backend at all
      // — see services/connect/radioMetadata.ts's own docstring for why
      // this needs its own explicit call.
      expect(radioMetadata.startRadioMetadataWatch).toHaveBeenCalledWith(
        'https://stream.example/chill',
      )
    })

    // A station published as a .m3u/.pls names where its audio really is
    // rather than being it — a Sonos answers `UPnP Error 800` and a browser's
    // <audio> simply fails to load. Resolved once here and used everywhere
    // below, so what this store holds matches what connect reports (see
    // playRadioStation()'s own comment on reconcileFromStatus()).
    it('plays what a playlist-file station actually points at, not the playlist', async () => {
      const playback = usePlaybackStore()
      const stream = 'http://dispatcher.rndfnk.com/br/br24/live/mp3/mid'
      vi.mocked(resolveRadioStreamUrl).mockResolvedValue(stream)

      await playback.playRadioStation({
        id: 'r1',
        name: 'B5 aktuell',
        streamUrl: 'http://streams.br.de/b5aktuell_2.m3u',
        homePageUrl: null,
      })

      expect(engine.play).toHaveBeenCalledWith(stream)
      expect(radioMetadata.startRadioMetadataWatch).toHaveBeenCalledWith(stream)
      expect(playback.radioStation?.streamUrl).toBe(stream)
      // Everything else about the station is untouched.
      expect(playback.radioStation?.name).toBe('B5 aktuell')
    })

    it('casts what a playlist-file station points at, not the playlist', async () => {
      const playback = usePlaybackStore()
      const stream = 'http://dispatcher.rndfnk.com/br/br24/live/mp3/mid'
      vi.mocked(resolveRadioStreamUrl).mockResolvedValue(stream)
      castTo()

      await playback.playRadioStation({
        id: 'r1',
        name: 'B5 aktuell',
        streamUrl: 'http://streams.br.de/b5aktuell_2.m3u',
        homePageUrl: null,
      })

      expect(connectPlayback.playUrl).toHaveBeenCalledWith(stream, 'B5 aktuell', expect.anything())
    })

    it('hands the raw stream URL to the cast targets, bypassing the library', async () => {
      const playback = usePlaybackStore()
      castTo()

      await playback.playRadioStation({
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })

      expect(connectPlayback.playUrl).toHaveBeenCalledWith(
        'https://stream.example/chill',
        'Chill FM',
        expect.objectContaining({ targets: [{ name: 'Living Room', type: 'sonos' }] }),
      )
      expect(engine.play).not.toHaveBeenCalled()
    })

    it('passes the radio-cast-directly setting through to /play-url', async () => {
      useRadioSettingsStore().setCastDirectly(true)
      const playback = usePlaybackStore()
      castTo()

      await playback.playRadioStation({
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })

      expect(connectPlayback.playUrl).toHaveBeenCalledWith(
        'https://stream.example/chill',
        'Chill FM',
        expect.objectContaining({ castDirectly: true }),
      )
    })

    it('stops the radio-metadata watch when a song queue replaces the playing station', async () => {
      const playback = usePlaybackStore()
      await playback.playRadioStation({
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })
      vi.mocked(radioMetadata.stopRadioMetadataWatch).mockClear()

      playback.setQueue([makeSong('a')], 0)

      expect(playback.radioStation).toBeNull()
      expect(playback.radioNowPlaying).toBeNull()
      expect(radioMetadata.stopRadioMetadataWatch).toHaveBeenCalledOnce()
    })

    it('does not call stopRadioMetadataWatch replacing a song queue with another', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)

      playback.setQueue([makeSong('b')], 0)

      expect(radioMetadata.stopRadioMetadataWatch).not.toHaveBeenCalled()
    })
  })

  describe('volume and ReplayGain', () => {
    it('keeps the stored volume and the element in step', () => {
      const playback = usePlaybackStore()

      playback.setVolume(0.35)

      expect(playback.volume).toBe(0.35)
      expect(engine.setVolume).toHaveBeenCalledWith(0.35)
    })

    it('applies a ReplayGain mode change to the song already playing', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a', { replayGain: { trackGain: -6, trackPeak: 1 } })], 0)

      playback.setReplayGainMode('song')

      expect(playback.replayGainMode).toBe('song')
      expect(engine.setReplayGain).toHaveBeenCalledWith(playback.replayGainMultiplier)
      await flushPromises()
    })

    it('leaves a running cast alone, where the gain is baked into the stream', () => {
      // ffmpeg's volume filter argument is fixed when the stream starts, so
      // this only takes effect from the next song onward while casting.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      castTo()

      playback.setReplayGainMode('album')

      expect(engine.setReplayGain).not.toHaveBeenCalled()
    })
  })

  describe('resetForLogout', () => {
    it('silences this device and drops the previous account queue', () => {
      // The store is a singleton for the app's lifetime, so without this
      // the next account would inherit songs it has no right to stream.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true

      playback.resetForLogout()

      expect(engine.stop).toHaveBeenCalledOnce()
      expect(playback.queue).toEqual([])
      expect(playback.currentIndex).toBe(-1)
      expect(playback.isPlaying).toBe(false)
    })
  })

  describe('setQueue', () => {
    it('keeps the song that was clicked playing, and shuffles the rest around it', () => {
      const playback = usePlaybackStore()
      const songs = [makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')]
      playback.shuffle = true

      playback.setQueue(songs, 2)

      expect(playback.currentSong?.id).toBe('c')
      expect(playback.currentIndex).toBe(0)
      expect(playback.queue.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd'])
      // The unshuffled order stays available for turning shuffle back off.
      expect(playback.originalQueue.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('plays the position that was clicked, not the first song sharing its id', () => {
      // A playlist can hold the same song twice; re-deriving the index by
      // id would jump to the wrong one of them.
      const playback = usePlaybackStore()
      const songs = [makeSong('a'), makeSong('b'), makeSong('a')]

      playback.setQueue(songs, 2)

      expect(playback.currentIndex).toBe(2)
    })
  })

  describe('hasNext / hasPrevious', () => {
    it('describes where the transport buttons can actually go', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      expect(playback.hasNext).toBe(true)
      expect(playback.hasPrevious).toBe(false)

      playback.currentIndex = 1
      expect(playback.hasNext).toBe(false)
      expect(playback.hasPrevious).toBe(true)
    })

    it('can always go both ways under repeat, which wraps around', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.repeatMode = 'all'

      expect(playback.hasNext).toBe(true)
      expect(playback.hasPrevious).toBe(true)
    })

    it('has nowhere to go with an empty queue', () => {
      const playback = usePlaybackStore()
      playback.repeatMode = 'all'

      expect(playback.hasNext).toBe(false)
      expect(playback.hasPrevious).toBe(false)
    })
  })
})
