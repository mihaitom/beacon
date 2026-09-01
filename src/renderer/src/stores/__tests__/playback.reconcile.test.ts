import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useLibraryStore } from '../library'
import { useConnectStore } from '../connect'
import { usePlaybackStore } from '../playback'
import { emitter } from '@/emitter'
import * as connectPlayback from '@/services/connect/playback'
import * as radioMetadata from '@/services/connect/radioMetadata'
import type { PlayResponse } from '@/services/connect/types'
import { makeSong, makeStatus } from './fixtures'

// Only `play()` needs to be under test control (its resolution timing is
// what pendingLocalSongChange guards against) — every other export stays
// real so useConnectStore()'s own imports of this module keep working.
vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return { ...actual, play: vi.fn() }
})
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
}))

describe('cast interruption', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('raises a toast offering to resume, rather than resuming by itself', async () => {
    /** Beacon cannot tell a device dropping out on its own apart from
     * someone pressing stop on the speaker — both end in a clean FIN with
     * the device reporting STOPPED and TransportStatus unchanged. So it
     * asks instead of guessing. */
    const playback = usePlaybackStore()
    const toasts: unknown[] = []
    emitter.on('toast', (t) => toasts.push(t))
    const resumeSpy = vi.spyOn(connectPlayback, 'resumeInterrupted').mockResolvedValue(undefined)

    playback.notifyCastInterrupted()

    expect(resumeSpy).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as {
      timeoutMs: number
      action: { label: string; onClick: () => void }
    }
    // A real button, not "click the toast somewhere" — see Toast.action.
    expect(toast.action.label).toBeTruthy()
    // Long enough to notice a question, read it and act on it.
    expect(toast.timeoutMs).toBeGreaterThan(12_000)

    toast.action.onClick()
    expect(resumeSpy).toHaveBeenCalledOnce()
    emitter.all.clear()
  })

  it('keeps the interruption as state so the phone remote can see it too', async () => {
    /** The remote protocol pushes debounced snapshots, so a toast alone
     * would never reach the phone - it renders a banner off this flag. */
    const playback = usePlaybackStore()
    emitter.on('toast', () => {})

    playback.notifyCastInterrupted()
    expect(playback.castInterrupted).toBe(true)

    vi.spyOn(connectPlayback, 'resumeInterrupted').mockResolvedValue(undefined)
    await playback.resumeAfterInterruption()
    expect(playback.castInterrupted).toBe(false)
    emitter.all.clear()
  })

  it('raises the toast once per broadcast, not on every store mutation', async () => {
    /** The bug this exists for: the connect store's $subscribe handler runs
     * on *every* mutation of that store and re-reads the same `state.status`
     * object, so one interrupted payload raised its toast over and over. And
     * no newer payload comes to clear it - once the session stops streaming,
     * /events falls back to heartbeats and that payload stays current, so it
     * repeated indefinitely rather than a few times. */
    const playback = usePlaybackStore()
    const connect = useConnectStore()
    const toasts: unknown[] = []
    emitter.on('toast', (t) => toasts.push(t))
    playback.init()

    connect.status = makeStatus({ interrupted: true, streaming: false })
    await flushPromises()
    expect(toasts).toHaveLength(1)

    // Anything else touching that store - a device scan finishing, a
    // connection flag flipping - must not re-raise it.
    connect.isScanning = true
    connect.connected = true
    await flushPromises()
    expect(toasts).toHaveLength(1)

    // A genuinely new interruption is a new payload, and does come through.
    connect.status = makeStatus({ interrupted: true, streaming: false })
    await flushPromises()
    expect(toasts).toHaveLength(2)
    emitter.all.clear()
  })

  it('drops a pending interruption when playback is dispatched somewhere else', async () => {
    const playback = usePlaybackStore()
    playback.castInterrupted = true
    vi.spyOn(useConnectStore(), 'claimDevices').mockResolvedValue()

    await playback.castTo([])

    expect(playback.castInterrupted).toBe(false)
  })
})

describe('reconcileFromStatus / adoptCastQueue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(connectPlayback.play).mockReset()
    vi.mocked(radioMetadata.stopRadioMetadataWatch).mockClear()
  })

  describe('radio', () => {
    it('does nothing while there is no live status yet (no current_song, no radio)', () => {
      const playback = usePlaybackStore()
      const a = makeSong('a')
      playback.setQueue([a], 0)

      void playback.reconcileFromStatus(makeStatus())

      expect(playback.queue).toEqual([a])
      expect(playback.currentIndex).toBe(0)
    })

    it('replaces the queue with the radio station and clears currentIndex when the stream URL changes', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)

      await playback.reconcileFromStatus(
        makeStatus({ radio: { title: 'Chill FM', url: 'https://stream.example/chill' } }),
      )

      expect(playback.queue).toEqual([])
      expect(playback.originalQueue).toEqual([])
      expect(playback.currentIndex).toBe(-1)
      expect(playback.radioStation).toEqual({
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      })
    })

    it("keeps the station's homepage by matching the library, so its logo survives", async () => {
      // The status carries only a title and a stream URL. Rebuilding the
      // station from those alone drops the homepage the logo is looked up
      // from (see radioFaviconUrl), leaving the player bar and Now Playing
      // on the generic radio icon for the rest of the session.
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      library.radioStations = [
        {
          id: 'r1',
          name: 'Chill FM',
          streamUrl: 'https://stream.example/chill',
          homePageUrl: 'https://chill.example',
        },
      ]

      await playback.reconcileFromStatus(
        makeStatus({ radio: { title: 'Chill FM', url: 'https://stream.example/chill' } }),
      )

      expect(playback.radioStation).toEqual(library.radioStations[0])
    })

    it('still matches by name when the reported URL is not the stored one', async () => {
      // A redirect resolved server-side means connect reports the URL it
      // actually streams from, not the one the station is saved with.
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      library.radioStations = [
        {
          id: 'r1',
          name: 'Chill FM',
          streamUrl: 'https://stream.example/chill',
          homePageUrl: 'https://chill.example',
        },
      ]

      await playback.reconcileFromStatus(
        makeStatus({ radio: { title: 'Chill FM', url: 'https://edge7.example/chill.mp3' } }),
      )

      expect(playback.radioStation?.homePageUrl).toBe('https://chill.example')
      // The URL actually playing, not the stored one — that's what the
      // next tick is compared against.
      expect(playback.radioStation?.streamUrl).toBe('https://edge7.example/chill.mp3')
    })

    it("keeps a Radio Browser station's favicon across a resolved-URL rebuild, since it can never match the library", async () => {
      // A station played straight out of RadioView.vue's discover dialog
      // (playBrowsedStation()) is deliberately never saved to
      // library.radioStations, so it can never be recovered by the
      // library-match branch above — and connect routinely reports back a
      // different final stream URL (a redirect, or a .m3u/.pls resolved to
      // what's inside it), which is exactly what triggers a rebuild here.
      // Losing the favicon on that rebuild left the player bar and Now
      // Playing on the generic radio icon for the rest of the session, on
      // essentially every browsed-station play — reported live 2026-09-01.
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: '',
        name: 'Found FM',
        streamUrl: 'https://browsed.example/found',
        homePageUrl: null,
        favicon: 'https://cdn.example/found.png',
      }

      await playback.reconcileFromStatus(
        makeStatus({
          radio: { title: 'Found FM', url: 'https://edge3.example/found.mp3' },
        }),
      )

      expect(playback.radioStation?.favicon).toBe('https://cdn.example/found.png')
      expect(playback.radioStation?.streamUrl).toBe('https://edge3.example/found.mp3')
    })

    it('does not carry a favicon over to a genuinely different station', async () => {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: '',
        name: 'Found FM',
        streamUrl: 'https://browsed.example/found',
        homePageUrl: null,
        favicon: 'https://cdn.example/found.png',
      }

      await playback.reconcileFromStatus(
        makeStatus({
          radio: { title: 'Somewhere Else FM', url: 'https://edge3.example/other.mp3' },
        }),
      )

      expect(playback.radioStation?.favicon).toBeUndefined()
    })

    it('leaves radioStation untouched (same object) when the same station repeats on the next tick', async () => {
      const playback = usePlaybackStore()
      const status = makeStatus({
        radio: { title: 'Chill FM', url: 'https://stream.example/chill' },
      })
      await playback.reconcileFromStatus(status)
      const stationAfterFirstTick = playback.radioStation

      await playback.reconcileFromStatus(status)

      expect(playback.radioStation).toBe(stationAfterFirstTick)
    })

    it('resets radioNowPlaying so a stale title from the previous station never lingers', async () => {
      const playback = usePlaybackStore()
      await playback.reconcileFromStatus(
        makeStatus({ radio: { title: 'Chill FM', url: 'https://stream.example/chill' } }),
      )
      playback.radioNowPlaying = 'Old Artist - Old Track'

      await playback.reconcileFromStatus(
        makeStatus({ radio: { title: 'Jazz FM', url: 'https://stream.example/jazz' } }),
      )

      expect(playback.radioNowPlaying).toBeNull()
    })

    it('leaves radioNowPlaying alone when the same station repeats on the next tick', async () => {
      const playback = usePlaybackStore()
      const status = makeStatus({
        radio: { title: 'Chill FM', url: 'https://stream.example/chill' },
      })
      await playback.reconcileFromStatus(status)
      playback.radioNowPlaying = 'Artist - Track'

      await playback.reconcileFromStatus(status)

      expect(playback.radioNowPlaying).toBe('Artist - Track')
    })
  })

  describe('the in-flight local song switch race', () => {
    it('does not blow away the queue when a stale SSE tick lands while our own startCurrent() is still awaiting the backend', async () => {
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      const [a, b, c] = [makeSong('a'), makeSong('b'), makeSong('c')]
      playback.setQueue([a, b, c], 0)
      // isCasting derives from connect.status.targets — a non-empty target
      // list is what routes startCurrent() through the connectPlayback.play()
      // branch instead of the local <audio> element.
      connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })

      // Keep connectPlayback.play() pending so pendingLocalSongChange (set
      // synchronously before the await) stays set for the assertions below.
      let resolvePlay!: (response: PlayResponse) => void
      vi.mocked(connectPlayback.play).mockReturnValue(
        new Promise((resolve) => {
          resolvePlay = resolve
        }),
      )
      const startCurrentPromise = playback.startCurrent()

      // A status tick reporting a queue this client doesn't recognize
      // arrives before the backend has processed our own dispatch —
      // without the pendingLocalSongChange guard this used to be read as
      // "adopt this instead" and collapse the queue down to it.
      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'b',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song b',
          },
          queue: ['b'],
          original_queue: ['b'],
          current_song_index: 0,
        }),
      )

      expect(playback.queue).toEqual([a, b, c])
      expect(playback.currentIndex).toBe(0)

      resolvePlay({ status: 'playing' })
      await startCurrentPromise
    })

    it('does adopt that same incoming queue once the in-flight switch has resolved', async () => {
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      const library = useLibraryStore()
      const [a, b, c] = [makeSong('a'), makeSong('b'), makeSong('c')]
      library.allSongs = [a, b, c]
      playback.setQueue([a, b, c], 0)
      connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })
      vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'playing' })

      await playback.startCurrent() // pendingLocalSongChange is set and cleared again within this await

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'b',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song b',
          },
          queue: ['b', 'c'],
          original_queue: ['b', 'c'],
          current_song_index: 0,
        }),
      )

      expect(playback.queue.map((s) => s.id)).toEqual(['b', 'c'])
    })
  })

  describe('adoptCastQueue', () => {
    it('stops the radio-metadata watch when the session switches from radio to a song queue', async () => {
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      const a = makeSong('a')
      library.allSongs = [a]
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.radioNowPlaying = 'Artist - Track'

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'a',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song a',
          },
          queue: ['a'],
          original_queue: ['a'],
          current_song_index: 0,
        }),
      )

      expect(playback.radioStation).toBeNull()
      expect(playback.radioNowPlaying).toBeNull()
      expect(radioMetadata.stopRadioMetadataWatch).toHaveBeenCalledOnce()
    })

    it('updates only currentIndex, keeping existing Song references, when the remote queue already matches', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      // Read back through the (reactive) store rather than comparing
      // against the raw makeSong() objects — Pinia hands out a stable
      // proxy per underlying object, but that proxy is never === the
      // unwrapped original.
      const [entryA, entryB] = playback.queue

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'b',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song b',
          },
          queue: ['a', 'b'],
          original_queue: ['a', 'b'],
          current_song_index: 1,
        }),
      )

      expect(playback.currentIndex).toBe(1)
      // Same object references — QueueDrawer.vue keys rows off these, not
      // just the id, so an unrelated row shouldn't re-render/re-animate.
      expect(playback.queue[0]).toBe(entryA)
      expect(playback.queue[1]).toBe(entryB)
    })

    it('adopts shuffle/repeatMode independently of whether the queue itself changed', async () => {
      const playback = usePlaybackStore()
      const [a, b] = [makeSong('a'), makeSong('b')]
      playback.setQueue([a, b], 0)
      expect(playback.shuffle).toBe(false)

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'a',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song a',
          },
          queue: ['a', 'b'],
          original_queue: ['a', 'b'],
          current_song_index: 0,
          shuffle: true,
          repeat_mode: 'all',
        }),
      )

      expect(playback.shuffle).toBe(true)
      expect(playback.repeatMode).toBe('all')
    })

    it('rebuilds the queue from a differing remote list, resolving unseen ids from the library', async () => {
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      const a = makeSong('a')
      const b = makeSong('b')
      const c = makeSong('c')
      library.allSongs = [a, b, c]
      playback.setQueue([a], 0)
      const entryA = playback.queue[0]

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'c',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Song c',
          },
          queue: ['a', 'b', 'c'],
          original_queue: ['a', 'b', 'c'],
          current_song_index: 2,
        }),
      )

      expect(playback.queue).toEqual([a, b, c])
      // Reuses this client's own existing object for 'a' rather than a
      // fresh one resolved from the library.
      expect(playback.queue[0]).toBe(entryA)
      expect(playback.currentIndex).toBe(2)
    })

    it('leaves local state untouched when a referenced song cannot be resolved anywhere', async () => {
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      const a = makeSong('a')
      library.allSongs = [a] // 'ghost' is in neither the library nor the local queue
      playback.setQueue([a], 0)

      await playback.reconcileFromStatus(
        makeStatus({
          current_song: {
            id: 'ghost',
            artist: '',
            album: '',
            cover_art_url: null,
            duration: 180,
            title: 'Ghost',
          },
          queue: ['a', 'ghost'],
          original_queue: ['a', 'ghost'],
          current_song_index: 1,
        }),
      )

      expect(playback.queue).toEqual([a])
      expect(playback.currentIndex).toBe(0)
    })
  })
})
