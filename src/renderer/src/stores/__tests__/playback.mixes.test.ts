import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { getAudioEngine } from '@/services/audioEngine'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Artist } from '@/types/library'
import { makeSong } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

interface Toast {
  title: string
  message: string
}

function stubSimilar(
  result: { songs: ReturnType<typeof makeSong>[]; plexPassRequired?: boolean } = { songs: [] },
): ReturnType<typeof vi.fn> {
  const getSimilarSongs2 = vi.fn().mockResolvedValue({ plexPassRequired: false, ...result })
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    getSimilarSongs2,
    streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
    scrobble: vi.fn().mockResolvedValue(undefined),
  } as unknown as SubsonicClient)
  return getSimilarSongs2
}

function makeArtist(id: string): Artist {
  return {
    id,
    name: `Artist ${id}`,
    albumCount: 3,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

describe('server-picked mixes', () => {
  let toasts: Toast[]

  beforeEach(() => {
    // The queue drawer peeks on every mix, which arms a real auto-close
    // timer — see playback.peek-queue-drawer.test.ts for what that does.
    vi.useFakeTimers()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(getAudioEngine).mockReturnValue({
      play: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setReplayGain: vi.fn(),
    } as unknown as ReturnType<typeof getAudioEngine>)
    toasts = []
    emitter.on('toast', (toast) => toasts.push(toast as Toast))
  })

  afterEach(() => {
    emitter.all.clear()
    vi.useRealTimers()
  })

  describe('Song Radio', () => {
    it('plays the song that was actually clicked first, then the mix around it', async () => {
      const playback = usePlaybackStore()
      const seed = makeSong('seed')
      stubSimilar({ songs: [makeSong('x'), makeSong('y')] })

      await playback.startSongRadio(seed)

      expect(playback.queue.map((s) => s.id)).toEqual(['seed', 'x', 'y'])
      expect(playback.currentIndex).toBe(0)
      expect(getAudioEngine().play).toHaveBeenCalledWith('https://server.example/stream/seed', 0, 1)
    })

    it('does not queue the seed twice when the server returns it as its own match', async () => {
      const playback = usePlaybackStore()
      const seed = makeSong('seed')
      stubSimilar({ songs: [makeSong('seed'), makeSong('x')] })

      await playback.startSongRadio(seed)

      expect(playback.queue.map((s) => s.id)).toEqual(['seed', 'x'])
    })

    it('shows what it picked, since nobody chose these songs song by song', async () => {
      const playback = usePlaybackStore()
      stubSimilar({ songs: [makeSong('x')] })

      await playback.startSongRadio(makeSong('seed'))

      expect(playback.queueDrawerOpen).toBe(true)
      expect(playback.queueRevealSeq).toBeGreaterThan(0)
    })

    it('explains that this server needs a Plex Pass for it', async () => {
      const playback = usePlaybackStore()
      stubSimilar({ songs: [], plexPassRequired: true })

      await playback.startSongRadio(makeSong('seed'))

      expect(toasts).toHaveLength(1)
      // Named after what the user pressed, not a generic failure.
      expect(toasts[0]!.title).toBe(i18n.global.t('library.songRadio'))
      expect(toasts[0]!.message).toBe(i18n.global.t('library.plexPassRequired'))
    })
  })

  describe('Artist Radio', () => {
    it('plays the mix across the catalog, with no one song pinned to the front', async () => {
      const playback = usePlaybackStore()
      const getSimilarSongs2 = stubSimilar({ songs: [makeSong('x'), makeSong('y')] })

      await playback.startArtistRadio(makeArtist('artist-7'))

      // Same endpoint as Song Radio, seeded with the artist's own id.
      expect(getSimilarSongs2).toHaveBeenCalledWith('artist-7')
      expect(playback.queue.map((s) => s.id)).toEqual(['x', 'y'])
      expect(playback.currentIndex).toBe(0)
    })

    it('names Artist Radio, not Song Radio, when the server needs a Plex Pass', async () => {
      const playback = usePlaybackStore()
      stubSimilar({ songs: [], plexPassRequired: true })

      await playback.startArtistRadio(makeArtist('artist-7'))

      expect(toasts[0]!.title).toBe(i18n.global.t('library.artistRadio'))
    })
  })
})
