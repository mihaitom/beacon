import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { useTransitionsStore } from '../transitions'
import { getAudioEngine } from '@/services/audioEngine'
import { getLocalMix, STALE_PAUSE_MS } from '@/services/playback/localMix'
import * as streamQuality from '@/services/streamQuality'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/services/playback/localMix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/playback/localMix')>()
  return { ...actual, getLocalMix: vi.fn() }
})

/** This device's mix, stood in for: what the store asks of it is the
 * subject here (the mix itself is tested in localMix.test.ts). */
function fakeMix() {
  const mix = {
    active: false,
    heard: vi.fn(),
    loadedThrough: vi.fn((): number | null => 0),
    nextLocked: false,
    start: vi.fn(async (_options: unknown) => {
      mix.active = true
      return true
    }),
    stop: vi.fn(() => {
      mix.active = false
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    pausedFor: vi.fn(() => 0),
    syncQueue: vi.fn(),
    onLost: null as (() => void) | null,
  }
  return mix
}

function fakeEngine() {
  return {
    play: vi.fn(),
    load: vi.fn(),
    playFrom: vi.fn(),
    loadFrom: vi.fn(),
    playLive: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setReplayGain: vi.fn(),
    hasEnded: false,
  }
}

let mix: ReturnType<typeof fakeMix>
let engine: ReturnType<typeof fakeEngine>
let scrobble: ReturnType<typeof vi.fn>

const songs = ['a', 'b', 'c'].map((id) => makeSong(id, { duration: 200 }))

async function playingQueue(index = 0) {
  const playback = usePlaybackStore()
  playback.setQueue(songs, index)
  await playback.startCurrent()
  await flushPromises()
  return playback
}

describe('playback with transitions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    mix = fakeMix()
    engine = fakeEngine()
    vi.mocked(getLocalMix).mockReturnValue(mix as never)
    vi.mocked(getAudioEngine).mockReturnValue(engine as never)
    scrobble = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
      scrobble,
      getSimilarSongs2: vi.fn().mockResolvedValue({ songs: [], plexPassRequired: false }),
    } as unknown as SubsonicClient)
  })

  it('without them, songs play one at a time and no mix is ever asked for', async () => {
    await playingQueue()
    expect(engine.play).toHaveBeenCalled()
    expect(mix.start).not.toHaveBeenCalled()
  })

  describe('turned on', () => {
    beforeEach(() => {
      useTransitionsStore().set({ mode: 'gapless' })
    })

    it('plays the queue as one mix from the current song', async () => {
      const playback = await playingQueue(1)
      expect(engine.play).not.toHaveBeenCalled()
      expect(engine.playFrom).not.toHaveBeenCalled()
      const options = mix.start.mock.calls[0]![0] as {
        songs: { id: string }[]
        position: number
        autoplay: boolean
      }
      expect(options.songs.map((s) => s.id)).toEqual(['b', 'c'])
      expect(options.autoplay).toBe(true)
      expect(playback.activeLocalStream?.reason).toBe('transitions')
      expect(playback.isPlaying).toBe(true)
    })

    it('falls back to the song on its own when connect cannot start a mix', async () => {
      mix.start.mockRejectedValueOnce(new Error('connect down'))
      await playingQueue()
      expect(engine.play).toHaveBeenCalled()
    })

    it('on WebKit too, which gets the mix as a live playlist', async () => {
      const webkit = vi.spyOn(streamQuality, 'prefersHls').mockReturnValue(true)
      await playingQueue()
      expect(mix.start).toHaveBeenCalled()
      webkit.mockRestore()
    })

    it('follows the mix into the next song without starting anything', async () => {
      const { onTimeUpdate } = initEngineCallbacks(usePlaybackStore())
      const playback = await playingQueue()
      engine.play.mockClear()
      mix.start.mockClear()
      scrobble.mockClear()

      mix.heard.mockReturnValue({ songId: 'a', queueIndex: 0, position: 150, startedAt: 0 })
      onTimeUpdate(150)
      expect(playback.localPosition).toBe(150)
      expect(playback.currentIndex).toBe(0)

      mix.heard.mockReturnValue({ songId: 'b', queueIndex: 1, position: 1, startedAt: 200 })
      onTimeUpdate(201)
      onTimeUpdate(201.25)
      expect(playback.currentIndex).toBe(1)
      expect(playback.localPosition).toBe(1)
      // Now-playing for the new song, once (150s into the first one also
      // submitted that one as played, which is the ordinary threshold).
      expect(scrobble.mock.calls.filter(([, played]) => !played)).toEqual([['b', false]])
      expect(mix.syncQueue).toHaveBeenCalled()
      expect(mix.start).not.toHaveBeenCalled()
      expect(engine.play).not.toHaveBeenCalled()
    })

    it('shows how far the current song is loaded, not how far the stream is', async () => {
      const { onTimeUpdate, onBufferedChange } = initEngineCallbacks(usePlaybackStore())
      const playback = await playingQueue()
      mix.heard.mockReturnValue({ songId: 'a', queueIndex: 0, position: 120, startedAt: 0 })
      mix.loadedThrough.mockReturnValue(150)
      onTimeUpdate(0)
      onBufferedChange(30)
      expect(mix.loadedThrough).toHaveBeenLastCalledWith(30)
      expect(playback.bufferedPosition).toBe(150)

      // Loaded into the next song: all of this one is in hand.
      mix.loadedThrough.mockReturnValue(null)
      onBufferedChange(90)
      expect(playback.bufferedPosition).toBe(200)
    })

    describe('once the mix has settled on the next song', () => {
      const five = ['a', 'b', 'c', 'd', 'e'].map((id) => makeSong(id, { duration: 200 }))
      const ids = (playback: ReturnType<typeof usePlaybackStore>) =>
        playback.queue.map((song) => song.id)

      async function locked() {
        const { onTimeUpdate } = initEngineCallbacks(usePlaybackStore())
        const playback = usePlaybackStore()
        playback.setQueue(five, 0)
        await playback.startCurrent()
        await flushPromises()
        mix.heard.mockReturnValue({ songId: 'a', queueIndex: 0, position: 190, startedAt: 0 })
        mix.nextLocked = true
        onTimeUpdate(190)
        return playback
      }

      it('takes the lock from the mix as it plays', async () => {
        const playback = await locked()
        expect(playback.lockedNextIndex).toBe(1)
      })

      it('"play next" goes in after it', async () => {
        const playback = await locked()
        playback.queueNext([makeSong('x')])
        expect(ids(playback)).toEqual(['a', 'b', 'x', 'c', 'd', 'e'])
      })

      it('it cannot be removed, or moved, or have a song moved in front of it', async () => {
        const playback = await locked()
        playback.removeFromQueue(1)
        playback.reorderQueue(1, 3)
        playback.reorderQueue(3, 1)
        playback.reorderQueue(0, 3)
        expect(ids(playback)).toEqual(['a', 'b', 'c', 'd', 'e'])
        // Everything behind it still moves.
        playback.reorderQueue(4, 2)
        playback.removeFromQueue(3)
        expect(ids(playback)).toEqual(['a', 'b', 'e', 'd'])
      })

      it('shuffling keeps it next', async () => {
        const playback = await locked()
        // Left to itself, this shuffle moves b to the end.
        const random = vi.spyOn(Math, 'random').mockReturnValue(0)
        playback.toggleShuffle()
        random.mockRestore()
        expect(ids(playback)).toEqual(['a', 'b', 'c', 'd', 'e'])
      })

      it('so does switching shuffle off', async () => {
        const playback = await locked()
        const [a, b, c, d, e] = playback.queue
        playback.queue = [a!, d!, b!, c!, e!]
        playback.shuffle = true
        playback.toggleShuffle()
        expect(ids(playback)).toEqual(['a', 'd', 'b', 'c', 'e'])
      })

      it('clearing the queue keeps it', async () => {
        const playback = await locked()
        playback.clearQueue()
        expect(ids(playback)).toEqual(['a', 'b'])
      })

      it('not under repeat-one, which plays the current song again', async () => {
        const playback = await locked()
        playback.repeatMode = 'one'
        playback.removeFromQueue(1)
        expect(ids(playback)).toEqual(['a', 'c', 'd', 'e'])
      })

      it("while casting, it comes from connect's status", async () => {
        const playback = usePlaybackStore()
        playback.setQueue(five, 0)
        const status = { queue: ids(playback), current_song_index: 0 }
        await playback.adoptCastQueue(makeStatus({ ...status, next_locked: true }))
        expect(playback.lockedNextIndex).toBe(1)
        await playback.adoptCastQueue(makeStatus({ ...status, next_locked: false }))
        expect(playback.lockedNextIndex).toBe(-1)
      })

      it("the current song's transition is the one told, from connect's status", async () => {
        const playback = usePlaybackStore()
        playback.setQueue(five, 0)
        const told = (song_id: string) => ({
          song_id,
          queue_index: null,
          kind: 'crossfade' as const,
          start: 170,
          change: 178,
          bpm: null,
        })
        const status = { queue: ids(playback), current_song_index: 0 }
        await playback.adoptCastQueue(makeStatus({ ...status, transitions: [told('z')] }))
        expect(playback.upcomingTransition).toBeNull()
        await playback.adoptCastQueue(
          makeStatus({ ...status, transitions: [told('z'), told('a')] }),
        )
        expect(playback.upcomingTransition?.song_id).toBe('a')
      })

      it('lifts once a new run starts', async () => {
        const playback = await locked()
        await playback.seek(10)
        expect(playback.lockedNextIndex).toBe(-1)
      })
    })

    it('a seek starts the mix over from there', async () => {
      const playback = await playingQueue()
      await playback.seek(90)
      await flushPromises()
      expect(mix.start).toHaveBeenLastCalledWith(expect.objectContaining({ position: 90 }))
      expect(engine.seek).not.toHaveBeenCalled()
    })

    it('pause and play reach the mix', async () => {
      const playback = await playingQueue()
      await playback.togglePlay()
      expect(engine.pause).toHaveBeenCalled()
      expect(mix.pause).toHaveBeenCalled()
      await playback.togglePlay()
      expect(engine.resume).toHaveBeenCalled()
      expect(mix.resume).toHaveBeenCalled()
    })

    it('a long pause starts over from where it stood', async () => {
      const playback = await playingQueue()
      await playback.togglePlay()
      playback.localPosition = 77
      mix.pausedFor.mockReturnValue(STALE_PAUSE_MS + 1)
      mix.start.mockClear()
      await playback.togglePlay()
      expect(mix.start).toHaveBeenCalledWith(expect.objectContaining({ position: 77 }))
      expect(engine.resume).not.toHaveBeenCalled()
      expect(playback.isPlaying).toBe(true)
    })

    it('a queue edit and a ReplayGain change are passed on to the mix', async () => {
      const playback = await playingQueue()
      mix.syncQueue.mockClear()
      playback.addToQueue([makeSong('d')])
      expect(mix.syncQueue).toHaveBeenCalledTimes(1)
      playback.setReplayGainMode('album')
      expect(mix.syncQueue).toHaveBeenCalledTimes(2)
      expect(engine.setReplayGain).not.toHaveBeenCalled()
    })

    it('a cast taking over ends the mix', async () => {
      const playback = await playingQueue()
      playback.yieldToCastPlayback()
      expect(mix.stop).toHaveBeenCalled()
    })
  })
})

/** The engine callbacks init() installs, without the rest of init(). */
function initEngineCallbacks(playback: ReturnType<typeof usePlaybackStore>) {
  playback.init()
  const installed = vi.mocked(getAudioEngine).mock.results.at(-1)!.value as {
    onTimeUpdate: (position: number) => void
    onBufferedChange: (end: number) => void
  }
  return {
    onTimeUpdate: (position: number) => installed.onTimeUpdate(position),
    onBufferedChange: (end: number) => installed.onBufferedChange(end),
  }
}
