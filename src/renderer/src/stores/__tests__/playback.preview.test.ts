import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { getAudioEngine } from '@/services/audioEngine'
import * as connectPlayback from '@/services/connect/playback'
import { getLocalMix, STALE_PAUSE_MS } from '@/services/playback/localMix'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return {
    ...actual,
    startPreview: vi.fn().mockResolvedValue(undefined),
    endPreview: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('@/services/playback/localMix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/playback/localMix')>()
  return { ...actual, getLocalMix: vi.fn() }
})

/** This device's mix, stood in for - the preview runs through it. */
function fakeMix() {
  const mix = {
    active: false,
    nextLocked: false,
    heard: vi.fn(),
    loadedThrough: vi.fn((): number | null => 0),
    start: vi.fn(async (_options: unknown) => {
      mix.active = true
      return true
    }),
    startPreview: vi.fn(async (_options: unknown) => {
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
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setReplayGain: vi.fn(),
    hasEnded: false,
    onTimeUpdate: null as ((position: number) => void) | null,
    onEnded: null as (() => void) | null,
  }
}

let mix: ReturnType<typeof fakeMix>
let engine: ReturnType<typeof fakeEngine>
let scrobble: ReturnType<typeof vi.fn>

const queue = ['q1', 'q2'].map((id) => makeSong(id, { duration: 200 }))
// Eight songs, so the preview has to choose six of them.
const album = Array.from({ length: 8 }, (_, i) => makeSong(`s${i}`, { duration: 240 }))

/** The queue playing q1, 50 s in, the way it stands before a preview. */
async function playingQueue() {
  const playback = usePlaybackStore()
  playback.init()
  playback.setQueue(queue, 0)
  await playback.startCurrent()
  await flushPromises()
  playback.localPosition = 50
  engine.play.mockClear()
  return playback
}

function previewed(): { id: string; queue_index: number }[] {
  return (
    mix.startPreview.mock.calls.at(-1)![0] as { songs: { id: string; queue_index: number }[] }
  ).songs
}

describe('previewing an album or playlist', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    // The first song of each sixth (see pickPreviewSongs()), so the songs a
    // test expects are the ones it gets.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    mix = fakeMix()
    engine = fakeEngine()
    vi.mocked(getLocalMix).mockReturnValue(mix as never)
    vi.mocked(getAudioEngine).mockReturnValue(engine as never)
    scrobble = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
      scrobble,
      getSimilarSongs2: vi.fn().mockResolvedValue({ songs: [], plexPassRequired: false }),
      getSong: vi.fn(async (id: string) => makeSong(id, { duration: 240 })),
    } as unknown as SubsonicClient)
  })

  it('plays excerpts of six songs, spread over the list, over the queue', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    expect(previewed().map((s) => s.id)).toEqual(['s0', 's1', 's2', 's4', 's5', 's6'])
    // Each song's place in the preview, which the timeline answers with.
    expect(previewed().map((s) => s.queue_index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(playback.currentSong?.id).toBe('s0')
    expect(playback.isPlaying).toBe(true)
    expect(playback.queue.map((s) => s.id)).toEqual(['q1', 'q2'])
    expect(playback.currentIndex).toBe(0)
  })

  it('follows the excerpts without moving the queue, scrobbling or syncing', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    scrobble.mockClear()
    mix.heard.mockReturnValue({ songId: 's1', queueIndex: 1, position: 130, startedAt: 20 })
    engine.onTimeUpdate!(36)
    expect(playback.currentSong?.id).toBe('s1')
    expect(playback.localPosition).toBe(130)
    expect(playback.duration).toBe(240)
    expect(playback.currentIndex).toBe(0)
    expect(scrobble).not.toHaveBeenCalled()
    expect(mix.syncQueue).not.toHaveBeenCalled()
  })

  it('skips between excerpts, and ends after the last', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    await playback.playNext()
    expect(mix.startPreview).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }))
    await playback.playPrevious()
    expect(mix.startPreview).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0 }))
    playback.preview!.index = 5
    await playback.playNext()
    expect(playback.preview).toBeNull()
  })

  it('ends in silence, the queue song back where it was, paused', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    playback.localPosition = 130
    engine.onEnded!()
    expect(playback.preview).toBeNull()
    expect(playback.isPlaying).toBe(false)
    expect(playback.currentSong?.id).toBe('q1')
    expect(playback.localPosition).toBe(50)
    const [url, position] = engine.load.mock.calls.at(-1)!
    expect([url, position]).toEqual([expect.stringContaining('q1'), 50])
    expect(engine.play).not.toHaveBeenCalled()
  })

  it('a second preview still goes back to where the queue was', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    playback.localPosition = 130
    await playback.startPreview(album.slice(0, 3))
    expect(playback.preview!.resumeAt).toBe(50)
  })

  it('plays the album from the previewed song, as an ordinary play', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    playback.preview!.index = 3 // s4
    await playback.playFromPreview()
    expect(playback.preview).toBeNull()
    expect(playback.queue.map((s) => s.id)).toEqual(album.map((s) => s.id))
    expect(playback.currentSong?.id).toBe('s4')
    expect(engine.play.mock.calls.at(-1)![0]).toContain('s4')
  })

  it('anything played from the queue replaces it', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    await playback.playAtIndex(1)
    expect(playback.preview).toBeNull()
    expect(playback.currentSong?.id).toBe('q2')
  })

  it('has nothing to seek in', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    mix.start.mockClear()
    mix.stop.mockClear()
    await playback.seek(10)
    // Nothing reaches the player: no seek, and no song started instead.
    expect(engine.seek).not.toHaveBeenCalled()
    expect(engine.play).not.toHaveBeenCalled()
    expect(mix.start).not.toHaveBeenCalled()
    expect(mix.stop).not.toHaveBeenCalled()
    expect(mix.startPreview).toHaveBeenCalledTimes(1)
    expect(playback.preview).not.toBeNull()
  })

  it('after a long pause starts the same excerpt over', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    playback.preview!.index = 3
    await playback.togglePlay()
    expect(mix.pause).toHaveBeenCalled()
    mix.pausedFor.mockReturnValue(STALE_PAUSE_MS + 1)
    await playback.togglePlay()
    expect(mix.startPreview).toHaveBeenLastCalledWith(expect.objectContaining({ index: 3 }))
    expect(mix.start).not.toHaveBeenCalled()
  })

  it('is never persisted: a reload is back on the queue song', async () => {
    const playback = await playingQueue()
    await playback.startPreview(album)
    playback.localPosition = 130
    playback.persistNow()
    const saved = JSON.parse(localStorage.getItem('beacon.playback')!) as Record<string, unknown>
    expect(saved.localPosition).toBe(50)
    expect(saved.currentIndex).toBe(0)
  })

  it('a preview connect cannot start ends right away', async () => {
    const playback = await playingQueue()
    mix.startPreview.mockRejectedValueOnce(new Error('connect down'))
    await playback.startPreview(album)
    expect(playback.preview).toBeNull()
    expect(playback.currentSong?.id).toBe('q1')
  })

  describe('while casting', () => {
    async function casting() {
      const playback = await playingQueue()
      vi.spyOn(useConnectStore(), 'isActive', 'get').mockReturnValue(true)
      return playback
    }

    it('plays on the speakers instead, through connect', async () => {
      const playback = await casting()
      await playback.startPreview(album)
      expect(mix.startPreview).not.toHaveBeenCalled()
      const [songs, index] = vi.mocked(connectPlayback.startPreview).mock.calls.at(-1)!
      expect(songs.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's4', 's5', 's6'])
      expect(index).toBe(0)
      await playback.playNext()
      expect(vi.mocked(connectPlayback.startPreview).mock.calls.at(-1)![1]).toBe(1)
      await playback.stop()
      expect(connectPlayback.endPreview).toHaveBeenCalled()
      expect(playback.preview).toBeNull()
    })

    it('a preview the speakers refused ends right away', async () => {
      const playback = await casting()
      vi.mocked(connectPlayback.startPreview).mockRejectedValueOnce(new Error('Not casting'))
      await playback.startPreview(album)
      expect(playback.preview).toBeNull()
    })

    it('follows the excerpt connect reports, and its end', async () => {
      const playback = await casting()
      await playback.startPreview(album)
      const ids = ['s0', 's1', 's2', 's4', 's5', 's6']
      await playback.adoptCastPreview(
        makeStatus({ preview: { song_ids: ids, index: 3, resume_at: 48 } }),
      )
      expect(playback.currentSong?.id).toBe('s4')
      expect(playback.preview!.resumeAt).toBe(48)
      expect(playback.preview!.whole).toBe(true)
      await playback.adoptCastPreview(makeStatus({ preview: null }))
      expect(playback.preview).toBeNull()
      expect(playback.currentSong?.id).toBe('q1')
    })

    it('takes up a preview another client started, without its album', async () => {
      const playback = await casting()
      await playback.adoptCastPreview(
        makeStatus({ preview: { song_ids: ['x1', 'x2'], index: 1, resume_at: 50 } }),
      )
      expect(playback.currentSong?.id).toBe('x2')
      expect(playback.preview!.whole).toBe(false)
    })

    it('leaves the preview alone while a request of its own is on its way', async () => {
      const playback = await casting()
      let answer!: () => void
      vi.mocked(connectPlayback.startPreview).mockReturnValueOnce(
        new Promise<void>((resolve) => (answer = resolve)),
      )
      const started = playback.startPreview(album)
      // Built before connect had the request.
      await playback.adoptCastPreview(makeStatus({ preview: null }))
      expect(playback.preview).not.toBeNull()
      answer()
      await started
    })

    it('takes it up from the status, and scrobbles nothing over it meanwhile', async () => {
      const playback = await playingQueue()
      scrobble.mockClear()
      // Mid-song, well past the scrobble threshold of the queue's song.
      useConnectStore().status = makeStatus({
        targets: [{ name: 'TV', type: 'chromecast' }],
        streaming: true,
        current_song: {
          id: 's3',
          artist: 'Artist',
          album: 'Album',
          cover_art_url: null,
          duration: 240,
          title: 'Song s3',
        },
        queue: ['q1', 'q2'],
        current_song_index: 0,
        elapsed: 200,
        preview: { song_ids: ['s3'], index: 0, resume_at: 50 },
      })
      await flushPromises()
      expect(playback.currentSong?.id).toBe('s3')
      expect(scrobble.mock.calls.filter(([, played]) => played)).toEqual([])
    })

    it('when the speakers go, back to the queue song here, where it was', async () => {
      const playback = await casting()
      await playback.startPreview(album)
      playback.localPosition = 130
      playback.prepareLocalPlayback()
      expect(playback.preview).toBeNull()
      const [url, position] = engine.load.mock.calls.at(-1)!
      expect([url, position]).toEqual([expect.stringContaining('q1'), 50])
    })
  })
})
