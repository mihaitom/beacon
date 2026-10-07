import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_CONCURRENT_FETCHES, usePlaylistSummariesStore } from '../playlistSummaries'
import { useLibraryStore } from '../library'
import { makeSong } from './fixtures'
import type { Playlist, Song } from '@/types/library'
import type { SubsonicClient } from '@/services/subsonic/client'

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: `List ${id}`,
    songCount: 1,
    duration: 180,
    coverArtId: 'server-art',
    public: false,
    owner: 'thomas',
    changed: '2026-01-01T00:00:00Z',
    songs: [],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let getPlaylist: ReturnType<typeof vi.fn>

function serve(songsById: Record<string, Song[]>) {
  getPlaylist.mockImplementation(async (id: string) => makePlaylist(id, { songs: songsById[id] }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  getPlaylist = vi.fn()
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    getPlaylist,
  } as unknown as SubsonicClient)
})

describe('playlist summaries', () => {
  it('summarises a playlist from its songs', async () => {
    serve({ p1: [makeSong('1', { coverArtId: 'a', artist: 'Björk' })] })
    const store = usePlaylistSummariesStore()
    const playlist = makePlaylist('p1')

    await store.ensure(playlist)

    expect(store.summaryFor(playlist)?.covers).toEqual(['a'])
    expect(store.summaryFor(playlist)?.artists).toEqual(['Björk'])
    expect(store.isSettled(playlist)).toBe(true)
  })

  it('fetches a version of a playlist once, however many cards ask', async () => {
    serve({ p1: [] })
    const store = usePlaylistSummariesStore()
    const playlist = makePlaylist('p1')

    await Promise.all([store.ensure(playlist), store.ensure(playlist)])
    await store.ensure({ ...playlist })

    expect(getPlaylist).toHaveBeenCalledTimes(1)
  })

  it('fetches again once the playlist was edited, keeping the old summary up meanwhile', async () => {
    serve({ p1: [makeSong('1', { coverArtId: 'old' })] })
    const store = usePlaylistSummariesStore()
    const before = makePlaylist('p1')
    await store.ensure(before)

    const pending = deferred<Playlist>()
    getPlaylist.mockReturnValueOnce(pending.promise)
    const after = makePlaylist('p1', { changed: '2026-02-01T00:00:00Z', songCount: 2 })
    const refresh = store.ensure(after)

    expect(store.summaryFor(after)?.covers).toEqual(['old'])
    expect(store.isSettled(after)).toBe(false)

    pending.resolve(makePlaylist('p1', { songs: [makeSong('2', { coverArtId: 'new' })] }))
    await refresh

    expect(store.summaryFor(after)?.covers).toEqual(['new'])
    expect(getPlaylist).toHaveBeenCalledTimes(2)
  })

  it('settles without a summary when the fetch fails, and does not retry that version', async () => {
    getPlaylist.mockRejectedValue(new Error('500'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = usePlaylistSummariesStore()
    const playlist = makePlaylist('p1')

    await store.ensure(playlist)
    await store.ensure(playlist)

    expect(store.summaryFor(playlist)).toBeNull()
    expect(store.isSettled(playlist)).toBe(true)
    expect(getPlaylist).toHaveBeenCalledTimes(1)
  })

  it(`never has more than ${MAX_CONCURRENT_FETCHES} playlists in flight`, async () => {
    const waiting: ReturnType<typeof deferred<Playlist>>[] = []
    getPlaylist.mockImplementation(() => {
      const next = deferred<Playlist>()
      waiting.push(next)
      return next.promise
    })
    const store = usePlaylistSummariesStore()
    const playlists = Array.from({ length: MAX_CONCURRENT_FETCHES + 3 }, (_, i) =>
      makePlaylist(`p${i}`),
    )

    const all = Promise.all(playlists.map((playlist) => store.ensure(playlist)))
    await flush()
    expect(getPlaylist).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES)

    waiting[0]!.resolve(makePlaylist('p0'))
    await flush()
    expect(getPlaylist).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES + 1)

    // A failure frees its slot as well.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    waiting[1]!.reject(new Error('timeout'))
    await flush()
    expect(getPlaylist).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES + 2)

    for (const next of waiting) next.resolve(makePlaylist('x'))
    await flush()
    for (const next of waiting) next.resolve(makePlaylist('x'))
    await all
    expect(getPlaylist).toHaveBeenCalledTimes(playlists.length)
  })

  it('drops what it knows on an account change, and an answer for the old account with it', async () => {
    serve({ p1: [makeSong('1', { coverArtId: 'a' })] })
    const store = usePlaylistSummariesStore()
    const playlist = makePlaylist('p1')
    await store.ensure(playlist)

    const pending = deferred<Playlist>()
    getPlaylist.mockReturnValueOnce(pending.promise)
    const edited = makePlaylist('p1', { songCount: 2 })
    const late = store.ensure(edited)
    store.reset()
    pending.resolve(makePlaylist('p1', { songs: [makeSong('2', { coverArtId: 'stale' })] }))
    await late

    expect(store.summaryFor(playlist)).toBeNull()
    expect(store.isSettled(edited)).toBe(false)
  })
})
