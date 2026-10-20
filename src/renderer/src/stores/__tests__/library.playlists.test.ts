import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../library'
import { useAuthStore } from '../auth'
import { emitter } from '@/emitter'
import type Toast from '@/types/toast'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Album, Artist, Playlist, Song } from '@/types/library'
import { setExactMatching } from '@/services/textSearch'
import { makeSong } from './fixtures'

// The cache lives in IndexedDB now (services/library/libraryCacheStore.ts),
// which jsdom has none of — stood in for by a plain map, same as
// library.cache.test.ts does. No account is logged in under test, so the
// record key is the bare field name.
const cache = vi.hoisted(() => new Map<string, { items: unknown[]; fetchedAt: number }>())
// The real write goes to IndexedDB and takes a moment to land. Tests that
// care about that moment turn this up; everything else leaves it at zero.
const writeDelayMs = vi.hoisted(() => ({ value: 0 }))
// Structured-cloned like IndexedDB does, and a failed clone swallowed like
// the real write does: handing it reactive store state must lose the write
// here too, not pass because a Map takes anything.

vi.mock('@/services/library/libraryCacheStore', () => ({
  LEGACY_CACHE_KEY: 'beacon.library-cache',
  readLibraryField: vi.fn(async (key: string) => cache.get(key) ?? null),
  writeLibraryField: vi.fn(async (key: string, items: unknown[], fetchedAt = Date.now()) => {
    if (writeDelayMs.value) await new Promise((resolve) => setTimeout(resolve, writeDelayMs.value))
    try {
      cache.set(key, { items: structuredClone(items), fetchedAt })
    } catch {
      // DataCloneError - the real store logs it and moves on.
    }
  }),
  clearLibraryFields: vi.fn((keys: string[]) => {
    for (const key of keys) cache.delete(key)
  }),
}))

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: `List ${id}`,
    songCount: 3,
    duration: 600,
    public: false,
    coverArtId: null,
    owner: 'thomas',
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
    ...overrides,
  }
}

function cachedPlaylists(): Playlist[] {
  return (cache.get('playlists')?.items ?? []) as Playlist[]
}

function stubClient(
  overrides: Record<string, unknown> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  const client = {
    getPlaylists: vi.fn().mockResolvedValue([]),
    createPlaylist: vi.fn().mockResolvedValue(undefined),
    addToPlaylist: vi.fn().mockResolvedValue(undefined),
    removeFromPlaylist: vi.fn().mockResolvedValue(undefined),
    setPlaylistSongs: vi.fn().mockResolvedValue(undefined),
    updatePlaylist: vi.fn().mockResolvedValue(undefined),
    deletePlaylist: vi.fn().mockResolvedValue(undefined),
    star: vi.fn().mockResolvedValue(undefined),
    unstar: vi.fn().mockResolvedValue(undefined),
    getStarred2: vi.fn().mockResolvedValue({ artists: [], albums: [], songs: [] }),
    search3: vi.fn().mockResolvedValue({ artists: [], albums: [], songs: [] }),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

describe('library mutations', () => {
  let toasts: Toast[]

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    // The exact mode is a module-wide preference; a test that turns it on
    // must not leak it into the next one.
    setExactMatching(false)
    cache.clear()
    writeDelayMs.value = 0
    toasts = []
    // The store emits on the real bus (see its announce()), not through a
    // component's this.$emitter.
    emitter.all.clear()
    emitter.on('toast', (toast) => {
      if (!Array.isArray(toast)) toasts.push(toast)
    })
    vi.restoreAllMocks()
  })

  afterEach(() => emitter.all.clear())

  it('offers only playlists that take songs as targets, owner or not', async () => {
    const library = useLibraryStore()
    library.playlists = [
      makePlaylist('mine'),
      makePlaylist('smart', { readonly: true, smart: true }),
      makePlaylist('theirs', { owner: 'anna', readonly: true }),
      // Jellyfin and Plex name no owner, and those playlists are writable.
      makePlaylist('bridged', { owner: '' }),
    ]

    expect(library.playlistsAcceptingSongs.map((playlist) => playlist.id)).toEqual([
      'mine',
      'bridged',
    ])
  })

  it('writes a deleted playlist out of the cache, not just out of memory', async () => {
    // Otherwise the next mount reads the cache-first path and, within the
    // hour-long TTL, serves the just-deleted playlist straight back.
    const library = useLibraryStore()
    stubClient()
    library.playlists = [makePlaylist('p1'), makePlaylist('p2')]

    await library.deletePlaylist('p1')

    expect(library.playlists.map((p) => p.id)).toEqual(['p2'])
    expect(cachedPlaylists().map((p) => p.id)).toEqual(['p2'])
  })

  it('does not let a deleted playlist come back when the page is reopened', async () => {
    // The cache write is asynchronous. If the delete returns before it has
    // landed, the next unforced read serves the old list straight back over
    // the in-memory one and the playlist reappears.
    const library = useLibraryStore()
    let listing = [makePlaylist('p1'), makePlaylist('p2')]
    stubClient({
      getPlaylists: vi.fn(async () => listing),
      deletePlaylist: vi.fn(async () => {
        listing = [makePlaylist('p2')]
      }),
    })
    await library.fetchPlaylists() // an earlier visit fills the cache

    writeDelayMs.value = 50
    await library.deletePlaylist('p1')
    await library.fetchPlaylists() // reopening the playlists page

    expect(library.playlists.map((p) => p.id)).toEqual(['p2'])
  })

  it('re-reads the playlist list long before the catalog cache would expire', async () => {
    // Playlists carry their own short TTL: the hour the catalog gets is
    // priced for re-reading 20k tracks, and a playlist list is one small
    // call that anything can change - another device, the server's own web
    // UI. Half a minute old is stale here and fresh for the catalog.
    const library = useLibraryStore()
    cache.set('playlists', {
      items: [makePlaylist('p1')],
      fetchedAt: Date.now() - 60_000,
    })
    const client = stubClient({
      getPlaylists: vi.fn(async () => [makePlaylist('p1'), makePlaylist('p2')]),
    })

    await library.fetchPlaylists()

    await vi.waitFor(() => expect(client.getPlaylists).toHaveBeenCalled())
    await vi.waitFor(() => expect(library.playlists.map((p) => p.id)).toEqual(['p1', 'p2']))
  })

  it('leaves a list it read seconds ago alone, so a context menu costs nothing', async () => {
    // The other half of that TTL: every track menu warms its playlist
    // picker with an unforced fetch, so this must not become a request per
    // right-click.
    const library = useLibraryStore()
    cache.set('playlists', { items: [makePlaylist('p1')], fetchedAt: Date.now() - 2_000 })
    const client = stubClient()

    await library.fetchPlaylists()

    expect(client.getPlaylists).not.toHaveBeenCalled()
    expect(library.playlists.map((p) => p.id)).toEqual(['p1'])
  })

  it('writes a rename through to the cache for the same reason', async () => {
    const library = useLibraryStore()
    stubClient()
    library.playlists = [makePlaylist('p1', { name: 'Old' })]

    await library.updatePlaylist('p1', { name: 'New', public: true })

    expect(library.playlists[0]!.name).toBe('New')
    expect(library.playlists[0]!.public).toBe(true)
    expect(cachedPlaylists()[0]!.name).toBe('New')
  })

  it('refetches the list after adding songs, so the song count is not left stale', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 5 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 3 })]

    await library.addToPlaylist('p1', ['s1', 's2'])

    expect(client.addToPlaylist).toHaveBeenCalledWith('p1', ['s1', 's2'])
    expect(library.playlists[0]!.songCount).toBe(5)
  })

  it('keeps a newly created playlist visible once the page is reopened', async () => {
    // The bug this guards: creating a playlist re-reads the list and writes
    // it to the cache, but the write is asynchronous. A page that then asks
    // for the list unforced (PlaylistsView's created()) gets whatever the
    // cache holds, and cachedFetch() hands that back over the newer list in
    // memory — then treats its recent timestamp as reason not to re-read.
    // The playlist created from the queue drawer disappeared again for as
    // long as the TTL ran, on Jellyfin a whole day.
    const library = useLibraryStore()
    let listing = [makePlaylist('a')]
    stubClient({
      getPlaylists: vi.fn(async () => listing),
      createPlaylist: vi.fn(async () => {
        listing = [makePlaylist('a'), makePlaylist('new')]
      }),
    })

    await library.fetchPlaylists() // an earlier visit fills the cache
    writeDelayMs.value = 50 // from here the cache takes its time, as it does
    await library.createPlaylist('New one')
    expect(library.playlists.map((playlist) => playlist.id)).toEqual(['a', 'new'])

    await library.fetchPlaylists() // reopening the playlists page

    expect(library.playlists.map((playlist) => playlist.id)).toEqual(['a', 'new'])
  })

  it('says so when a playlist is created, for the pages that cannot show it', async () => {
    const library = useLibraryStore()
    stubClient()

    await library.createPlaylist('Road trip')

    expect(toasts.at(-1)?.level).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Road trip')
  })

  it('names the playlist a song was added to', async () => {
    const library = useLibraryStore()
    stubClient({
      getPlaylists: vi.fn(async () => [makePlaylist('p1', { name: 'Road trip' })]),
    })

    await library.addToPlaylist('p1', ['s1'])
    expect(toasts.at(-1)?.message).toContain('Road trip')

    await library.addToPlaylist('p1', ['s1', 's2', 's3'])
    // The count matters as much as the name: "add to playlist" on a
    // multi-selection is one gesture and three tracks.
    expect(toasts.at(-1)?.message).toContain('3')
    expect(toasts.at(-1)?.message).toContain('Road trip')
  })

  it('refetches the list after removing songs, so the song count is not left stale', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 1 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 3 })]

    await library.removeFromPlaylist('p1', [2, 0])

    expect(client.removeFromPlaylist).toHaveBeenCalledWith('p1', [2, 0])
    expect(library.playlists[0]!.songCount).toBe(1)
  })

  it('removes without touching the shared loading flag', async () => {
    // Same reasoning as the reorder below: the row is already gone from
    // the view, so a loader over it would only flash.
    const library = useLibraryStore()
    const client = stubClient()
    let loadingDuringCall = false
    client.removeFromPlaylist!.mockImplementation(() => {
      loadingDuringCall = library.loading
      return Promise.resolve()
    })

    await library.removeFromPlaylist('p1', [0])

    expect(loadingDuringCall).toBe(false)
  })

  it('restores a playlist by sending the complete list back, and refreshes the count', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 3 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 2 })]

    await library.restorePlaylistSongs('p1', ['a', 'b', 'c'])

    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['a', 'b', 'c'])
    expect(library.playlists[0]!.songCount).toBe(3)
  })

  it('still counts as done when only the list refresh fails', async () => {
    // The entry really is gone by then. Passing the refresh's failure on
    // would report a removal that worked as one that didn't, and offer to
    // undo it.
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockRejectedValue(new Error('offline')),
    })

    await expect(library.removeFromPlaylist('p1', [0])).resolves.toBeUndefined()
    await expect(library.restorePlaylistSongs('p1', ['a'])).resolves.toBeUndefined()

    expect(client.removeFromPlaylist).toHaveBeenCalledWith('p1', [0])
    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['a'])
  })

  it('reorders without touching the shared loading flag', async () => {
    // The view has already moved the row and reverts it itself on failure;
    // flashing a loader over a change that is already visible is wrong.
    const library = useLibraryStore()
    const client = stubClient()
    let loadingDuringCall = false
    client.setPlaylistSongs!.mockImplementation(() => {
      loadingDuringCall = library.loading
      return Promise.resolve()
    })

    await library.reorderPlaylist('p1', ['b', 'a'])

    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['b', 'a'])
    expect(loadingDuringCall).toBe(false)
  })

  it('unstars something that is starred and stars something that is not', async () => {
    const library = useLibraryStore()
    const client = stubClient()

    await library.toggleStar({ id: 's1', starred: true })
    expect(client.unstar).toHaveBeenCalledWith({
      id: 's1',
      albumId: undefined,
      artistId: undefined,
    })
    expect(client.star).not.toHaveBeenCalled()

    await library.toggleStar({ albumId: 'al1', starred: false })
    expect(client.star).toHaveBeenCalledWith({ id: undefined, albumId: 'al1', artistId: undefined })
    // Re-read afterwards, so every view showing the starred lists agrees.
    expect(client.getStarred2).toHaveBeenCalledTimes(2)
  })

  describe('favourites on the item itself', () => {
    it('flips the song it was handed, and names it by the right key', async () => {
      useAuthStore().serverType = 'subsonic'
      const library = useLibraryStore()
      const client = stubClient()
      const song = makeSong('s1', { starred: false, rating: 3 })

      await library.toggleFavorite('song', song)

      expect(client.star).toHaveBeenCalledWith({
        id: 's1',
        albumId: undefined,
        artistId: undefined,
      })
      expect(song.starred).toBe(true)
      // Two separate things off Plex.
      expect(song.rating).toBe(3)
    })

    it('names an album and an artist by their own keys', async () => {
      const library = useLibraryStore()
      const client = stubClient()

      await library.toggleFavorite('album', { id: 'al1', starred: true } as never)
      await library.toggleFavorite('artist', { id: 'ar1', starred: false } as never)

      expect(client.unstar).toHaveBeenCalledWith({
        id: undefined,
        albumId: 'al1',
        artistId: undefined,
      })
      expect(client.star).toHaveBeenCalledWith({
        id: undefined,
        albumId: undefined,
        artistId: 'ar1',
      })
    })

    it('leaves the song as it was when the server refuses', async () => {
      const library = useLibraryStore()
      stubClient({ star: vi.fn().mockRejectedValue(new Error('nope')) })
      const song = makeSong('s1', { starred: false })

      await expect(library.toggleFavorite('song', song)).rejects.toThrow()

      expect(song.starred).toBe(false)
    })

    it('shows a new rating at once and sends it for the object it was given', async () => {
      const library = useLibraryStore()
      const client = stubClient({ setRating: vi.fn().mockResolvedValue(undefined) })
      const song = makeSong('s1', { rating: 2 })

      await library.rate(song, 4)

      expect(client.setRating).toHaveBeenCalledWith('s1', 4)
      expect(song.rating).toBe(4)
    })

    it('puts the old rating back when the server refuses the new one', async () => {
      const library = useLibraryStore()
      stubClient({ setRating: vi.fn().mockRejectedValue(new Error('nope')) })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const song = makeSong('s1', { rating: 2 })

      await library.rate(song, 5)

      expect(song.rating).toBe(2)
    })

    /** On Plex the heart and the fifth star are one value on the server,
     * so the two may not disagree on screen either. */
    describe('where a favourite is five stars (Plex)', () => {
      beforeEach(() => {
        useAuthStore().serverType = 'plex'
      })

      it('gives a new favourite five stars, and takes them away with it', async () => {
        const library = useLibraryStore()
        stubClient()
        const song = makeSong('s1', { starred: false, rating: 3 })

        await library.toggleFavorite('song', song)
        expect(song.rating).toBe(5)

        await library.toggleFavorite('song', song)
        expect(song.starred).toBe(false)
        expect(song.rating).toBe(0)
      })

      it('makes five stars a favourite, and anything less not one', () => {
        const library = useLibraryStore()
        const song = makeSong('s1', { starred: false, rating: 3 })

        library.markRating(song, 5)
        expect(song.starred).toBe(true)

        library.markRating(song, 4)
        expect(song.starred).toBe(false)
      })
    })

    it('leaves the favourite alone when the rating changes elsewhere', () => {
      useAuthStore().serverType = 'subsonic'
      const library = useLibraryStore()
      const song = makeSong('s1', { starred: true, rating: 5 })

      library.markRating(song, 2)

      expect(song.starred).toBe(true)
    })

    /** The album page and the album list hold two different objects for one
     * album, and the list is what the IndexedDB cache is written from. */
    describe('every copy of the same item', () => {
      const album = (id: string, overrides: Partial<Album> = {}): Album =>
        ({ id, name: id, rating: 0, starred: false, songs: [], ...overrides }) as Album
      const artist = (id: string, overrides: Partial<Artist> = {}): Artist =>
        ({ id, name: id, rating: 0, starred: false, albums: [], ...overrides }) as Artist

      it("reaches the album list and its cache from the album's own page", async () => {
        const library = useLibraryStore()
        stubClient({ setRating: vi.fn().mockResolvedValue(undefined) })
        library.albums = [album('al1'), album('al2')]
        library.albumCache = { al1: album('al1') }

        await library.rate(library.albumCache.al1!, 4)
        await vi.waitFor(() => expect(cache.has('albums')).toBe(true))

        expect(library.albums.map((entry) => entry.rating)).toEqual([4, 0])
        expect((cache.get('albums')!.items as Album[])[0]!.rating).toBe(4)
      })

      it("reaches the artist list from the artist's own page, heart included", async () => {
        const library = useLibraryStore()
        stubClient()
        library.artists = [artist('ar1')]
        library.artistCache = { ar1: artist('ar1') }

        await library.toggleFavorite('artist', library.artistCache.ar1!)

        expect(library.artists[0]!.starred).toBe(true)
      })

      it('reaches the catalogue from a song on its album page, and caches it once complete', async () => {
        const library = useLibraryStore()
        library.allSongs = [makeSong('s1')]
        library.albumCache = { al1: album('al1', { songs: [makeSong('s1')] }) }

        library.markRating(library.albumCache.al1!.songs[0]!, 3)
        await Promise.resolve()
        expect(library.allSongs[0]!.rating).toBe(3)
        expect(cache.has('songs')).toBe(false)

        library.allSongsLoaded = true
        library.markRating(library.albumCache.al1!.songs[0]!, 2)
        await vi.waitFor(() => expect(cache.has('songs')).toBe(true))
        expect((cache.get('songs')!.items as Song[])[0]!.rating).toBe(2)
      })

      it('reaches an album page already open from the song list', () => {
        const library = useLibraryStore()
        library.allSongs = [makeSong('s1')]
        library.albumCache = { al1: album('al1', { songs: [makeSong('s1')] }) }

        library.markFavorite(library.allSongs[0]!, true)

        expect(library.albumCache.al1!.songs[0]!.starred).toBe(true)
      })

      it('takes the rating back out of every copy when the server refuses it', async () => {
        const library = useLibraryStore()
        stubClient({ setRating: vi.fn().mockRejectedValue(new Error('nope')) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        library.albums = [album('al1', { rating: 1 })]
        library.albumCache = { al1: album('al1', { rating: 1 }) }

        await library.rate(library.albumCache.al1!, 5)

        expect(library.albums[0]!.rating).toBe(1)
      })
    })
  })

  it('clears the results for an empty search instead of searching for nothing', async () => {
    const library = useLibraryStore()
    const fetchSongs = vi.spyOn(library, 'fetchAllSongs')
    library.searchResults = { artists: [], albums: [], songs: [] }

    await library.search('   ')

    expect(fetchSongs).not.toHaveBeenCalled()
    expect(library.searchResults).toEqual({ artists: [], albums: [], songs: [] })
  })

  /** The general search runs over the loaded library with the forgiving
   * matcher the filter fields use, not over the server's own search — see
   * search()'s own comment. */
  it('searches the loaded library itself, tolerating a misspelling', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    vi.spyOn(library, 'fetchArtists').mockResolvedValue()
    library.allSongs = [
      makeSong('s1', { title: 'Earth Song', artist: 'Michael Jackson', album: 'HIStory' }),
      makeSong('s2', { title: 'Unrelated', artist: 'Nobody', album: 'Else' }),
    ]

    await library.search('erth song')

    expect(library.searchResults.songs.map((s) => s.id)).toEqual(['s1'])
  })

  it('searches albums and artists as well as songs', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    vi.spyOn(library, 'fetchArtists').mockResolvedValue()
    library.albums = [{ id: 'al1', name: 'Earth', artist: 'Michael Jackson' } as never]
    library.artists = [{ id: 'ar1', name: 'Earth Wind & Fire' } as never]

    await library.search('erth')

    expect(library.searchResults.albums.map((a) => a.id)).toEqual(['al1'])
    expect(library.searchResults.artists.map((a) => a.id)).toEqual(['ar1'])
  })

  it('orders the results by how well they match, not by catalog order', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    vi.spyOn(library, 'fetchArtists').mockResolvedValue()
    library.allSongs = [
      makeSong('s1', { title: 'Players Club', artist: 'Someone' }),
      makeSong('s2', { title: 'Players', artist: 'Someone' }),
      makeSong('s3', { title: 'Other', artist: 'The Players' }),
    ]

    await library.search('players')

    // Exact title first, then the title containing the word, then the artist
    // match - the reported case was the exact title landing far down the list.
    expect(library.searchResults.songs.map((s) => s.id)).toEqual(['s2', 's1', 's3'])
  })

  it('drops the misspelling match once exact mode is on, keeping fragments', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    vi.spyOn(library, 'fetchArtists').mockResolvedValue()
    library.allSongs = [
      makeSong('s1', { title: 'Players', artist: 'Someone' }),
      makeSong('s2', { title: 'Overplayers', artist: 'Someone' }),
      makeSong('s3', { title: 'Playres', artist: 'Someone' }),
    ]
    library.setSearchExact(true)

    await library.search('players')

    // The fragment ("Overplayers") still matches; the misspelling does not.
    expect(library.searchResults.songs.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  describe('findLibrarySong', () => {
    it('returns the library song the matcher picks for a radio entry', async () => {
      const library = useLibraryStore()
      const song = makeSong('s1', { title: 'Show Me Love', artist: 'WizTheMc' })
      stubClient({
        search3: vi.fn().mockResolvedValue({ artists: [], albums: [], songs: [song] }),
      })

      await expect(library.findLibrarySong('WizTheMc, bees & honey', 'Show Me Love')).resolves.toBe(
        song,
      )
    })

    it('returns null when nothing in the library is close enough', async () => {
      const library = useLibraryStore()
      stubClient({
        search3: vi.fn().mockResolvedValue({
          artists: [],
          albums: [],
          songs: [makeSong('x', { title: 'Unrelated', artist: 'Nobody' })],
        }),
      })

      await expect(library.findLibrarySong('WizTheMc', 'Show Me Love')).resolves.toBeNull()
    })
  })
})
