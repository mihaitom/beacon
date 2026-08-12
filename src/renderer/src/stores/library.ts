import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { SubsonicClient } from '@/services/subsonic/client'
import type { Album, Artist, Genre, Playlist, RadioStation, Track } from '@/types/library'

// Dedupes concurrent fetchAllTracks() calls — fetchAlbum()'s derived path
// (and things that fan out into many fetchAlbum() calls at once, like
// fetchTopTracksForArtist()'s Promise.all) can all end up awaiting this at
// the same moment; without this they'd each see allTracksLoaded still false
// and kick off their own redundant parallel fetch of the whole catalog.
let fetchAllTracksPromise: Promise<void> | null = null

// Single localStorage cache for library data that's expensive to fetch in
// full but rarely changes between app launches — one shared blob (not a key
// per data type) since it's conceptually one thing: "the library as last
// seen." Fetch functions below read/write just their own field, but it all
// lives under one beacon.library-cache entry.
const LIBRARY_CACHE_KEY = 'beacon.library-cache'

interface LibraryCacheSnapshot {
  tracks?: Track[]
  artists?: Artist[]
  albums?: Album[]
  playlists?: Playlist[]
}

function loadLibraryCache(): LibraryCacheSnapshot {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY)
    return raw ? (JSON.parse(raw) as LibraryCacheSnapshot) : {}
  } catch {
    return {}
  }
}

function saveLibraryCacheField<K extends keyof LibraryCacheSnapshot>(
  field: K,
  value: LibraryCacheSnapshot[K],
): void {
  try {
    const current = loadLibraryCache()
    current[field] = value
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(current))
  } catch {
    // Quota exceeded (a large library's full track catalog can run several
    // MB) or storage unavailable — falling back to fetching fresh every
    // time is an acceptable degradation, not worth surfacing to the user.
  }
}

/** Called from authStore.logout() — a different account's library shouldn't
 * leak into whoever logs in next, same reasoning as clearPersistedPlayback(). */
export function clearLibraryCache(): void {
  try {
    localStorage.removeItem(LIBRARY_CACHE_KEY)
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}

/** Fetches every page of the flat track catalog (search3 with an empty
 * query) and returns it as one array — used for the cache-refresh path in
 * fetchAllTracks(), where nothing should touch reactive state until the
 * whole thing is done (see that method's comment for why). */
async function fetchTrackPages(client: SubsonicClient, pageSize: number): Promise<Track[]> {
  let all: Track[] = []
  let offset = 0
  while (true) {
    const page = await client.search3('', pageSize, 0, 0, offset)
    if (page.tracks.length === 0) break
    all = all.concat(page.tracks)
    if (page.tracks.length < pageSize) break
    offset += pageSize
  }
  return all
}

/** Fetches the full album catalog page by page via getAlbumList2 — its own
 * request, deliberately not derived from allTracks. Deriving would mean
 * AlbumsView (a plain browse grid) has to wait for the entire track catalog
 * just to show album cards, which is a needless latency regression for
 * something getAlbumList2 already answers directly and quickly. */
async function fetchAlbumPages(client: SubsonicClient, pageSize: number): Promise<Album[]> {
  let all: Album[] = []
  let offset = 0
  while (true) {
    const page = await client.getAlbumList2('alphabeticalByName', pageSize, offset)
    if (page.length === 0) break
    all = all.concat(page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  return all
}

/** Shows a cached value instantly (if there is one) while `fetcher` always
 * runs to get the current data, updating both state (via `onResult`) and
 * the cache once it resolves — a no-op visually unless something actually
 * changed since. Falls back to a plain withLoading()-wrapped fetch (drives
 * the caller's usual loading spinner/skeleton) when there's no cache yet. */
async function cachedFetch<K extends keyof LibraryCacheSnapshot>(
  store: { withLoading<R>(fn: () => Promise<R>): Promise<R> },
  field: K,
  fetcher: () => Promise<NonNullable<LibraryCacheSnapshot[K]>>,
  onResult: (value: NonNullable<LibraryCacheSnapshot[K]>) => void,
): Promise<void> {
  const cached = loadLibraryCache()[field]
  if (cached) {
    onResult(cached as NonNullable<LibraryCacheSnapshot[K]>)
    fetcher()
      .then((fresh) => {
        onResult(fresh)
        saveLibraryCacheField(field, fresh)
      })
      .catch((error) => {
        console.error(`[library] Background refresh failed for ${field}:`, error)
      })
    return
  }
  await store.withLoading(async () => {
    const fresh = await fetcher()
    onResult(fresh)
    saveLibraryCacheField(field, fresh)
  })
}

interface LibraryState {
  artists: Artist[]
  albums: Album[]
  allTracks: Track[]
  allTracksLoaded: boolean
  playlists: Playlist[]
  radioStations: RadioStation[]
  starred: { artists: Artist[]; albums: Album[]; tracks: Track[] }
  searchResults: { artists: Artist[]; albums: Album[]; tracks: Track[] }
  // Per-album cache for fetchAlbum() — list-level Album entries (from
  // fetchAlbums()/getAlbumList2) don't carry a full track list, so opening
  // a single album always needs its own getAlbum(id) call regardless.
  albumCache: Record<string, Album>
  artistCache: Record<string, Artist>
  // Count of in-flight withLoading() calls rather than a plain boolean —
  // several independent fetches commonly run concurrently (e.g. HomeView's
  // created() fires 4+ of them at once), and a shared boolean would flip to
  // false as soon as the *first* one finishes even though others are still
  // in flight. See the `loading` getter below.
  loadingCount: number
  error: string | null
}

export const useLibraryStore = defineStore('library', {
  state: (): LibraryState => ({
    artists: [],
    albums: [],
    allTracks: [],
    allTracksLoaded: false,
    playlists: [],
    radioStations: [],
    starred: { artists: [], albums: [], tracks: [] },
    searchResults: { artists: [], albums: [], tracks: [] },
    albumCache: {},
    artistCache: {},
    loadingCount: 0,
    error: null,
  }),

  getters: {
    loading: (state): boolean => state.loadingCount > 0,
    /** Derived from allTracks rather than its own fetch — every field a
     * Genre needs (name, songCount, distinct albumCount) is already right
     * there on each track, so a whole separate getGenres.view round trip
     * (and cache entry) would just be duplicating data we're loading
     * anyway. See fetchGenres(), which just makes sure allTracks is
     * populated first. */
    genres(state): Genre[] {
      const byName = new Map<string, { albumIds: Set<string>; songCount: number }>()
      for (const track of state.allTracks) {
        if (!track.genre) continue
        let entry = byName.get(track.genre)
        if (!entry) {
          entry = { albumIds: new Set(), songCount: 0 }
          byName.set(track.genre, entry)
        }
        entry.albumIds.add(track.albumId)
        entry.songCount++
      }
      return Array.from(byName.entries()).map(([name, { albumIds, songCount }]) => ({
        name,
        albumCount: albumIds.size,
        songCount,
      }))
    },
  },

  actions: {
    client(): SubsonicClient {
      const auth = useAuthStore()
      return new SubsonicClient(auth.connectUrl, auth.credential, auth.connectToken)
    },

    async withLoading<T>(fn: () => Promise<T>): Promise<T> {
      this.loadingCount++
      this.error = null
      try {
        return await fn()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.loadingCount--
      }
    },

    /** Own request, own cache field — same stale-while-revalidate pattern as
     * fetchArtists()/fetchPlaylists(), fetching the whole catalog page by
     * page via getAlbumList2 (see fetchAlbumPages()). Deliberately NOT
     * derived from allTracks: that would force AlbumsView to wait on the
     * entire track catalog just to render a grid of album cards. */
    async fetchAlbums(): Promise<void> {
      if (this.albums.length > 0) return
      const ALBUM_PAGE_SIZE = 500
      await cachedFetch(
        this,
        'albums',
        () => fetchAlbumPages(this.client(), ALBUM_PAGE_SIZE),
        (albums) => (this.albums = albums),
      )
    },

    /** List-level Album entries (from fetchAlbums()) never carry a full
     * track list, so opening a single album always needs its own
     * getAlbum(id) request — cached in albumCache so revisiting the same
     * album (e.g. via back/forward navigation) doesn't re-fetch. */
    async fetchAlbum(id: string): Promise<Album> {
      if (this.albumCache[id]) return this.albumCache[id]
      return this.withLoading(async () => {
        const album = await this.client().getAlbum(id)
        this.albumCache[id] = album
        return album
      })
    },

    async fetchArtists(): Promise<void> {
      if (this.artists.length > 0) return
      await cachedFetch(
        this,
        'artists',
        () => this.client().getArtists(),
        (artists) => (this.artists = artists),
      )
    },

    async fetchArtist(id: string): Promise<Artist> {
      if (this.artistCache[id]) return this.artistCache[id]
      return this.withLoading(async () => {
        const artist = await this.client().getArtist(id)
        this.artistCache[id] = artist
        return artist
      })
    },

    /** Top tracks for an artist by local playCount, sorted descending. There's
     * no direct Subsonic endpoint for this (getArtist.view's albums don't
     * include song lists, only album-level metadata) — fetches each album's
     * full track list (via the same cache as fetchAlbum()) and aggregates. */
    async fetchTopTracksForArtist(artist: Artist, limit = 10): Promise<Track[]> {
      const albums = await Promise.all(artist.albums.map((album) => this.fetchAlbum(album.id)))
      return albums
        .flatMap((album) => album.tracks)
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, limit)
    },

    /** For HomeView's shelves — each a thin wrapper over getAlbumList2's
     * different sort types, not cached (Home is meant to feel current each
     * visit, and "random"/"recent" would go stale if cached anyway). */
    async fetchFrequentAlbums(size = 15): Promise<Album[]> {
      return this.withLoading(() => this.client().getAlbumList2('frequent', size))
    },
    async fetchRecentlyPlayedAlbums(size = 15): Promise<Album[]> {
      return this.withLoading(() => this.client().getAlbumList2('recent', size))
    },
    async fetchRandomAlbums(size = 15): Promise<Album[]> {
      return this.withLoading(() => this.client().getAlbumList2('random', size))
    },

    /** Top tracks across the whole library by local playCount. There's no
     * "most played songs" Subsonic endpoint, so this samples from the
     * frequently-played albums (already a playCount-sorted list) and
     * aggregates their tracks — cheap (a handful of albums, using the same
     * fetchAlbum cache) compared to sorting the entire catalog for a
     * homepage widget. */
    async fetchTopTracks(limit = 10): Promise<Track[]> {
      return this.withLoading(async () => {
        const frequentAlbums = await this.client().getAlbumList2('frequent', 20)
        const albums = await Promise.all(frequentAlbums.map((album) => this.fetchAlbum(album.id)))
        return albums
          .flatMap((album) => album.tracks)
          .sort((a, b) => b.playCount - a.playCount)
          .slice(0, limit)
      })
    },

    /** genres is derived from allTracks (see the getter above) — this just
     * makes sure that's actually loaded. */
    async fetchGenres(): Promise<void> {
      await this.fetchAllTracks()
    },

    /** Derived from allTracks, same as the genres getter above — deliberately
     * NOT getSongsByGenre.view, which Navidrome silently caps at 500 and,
     * worse, keeps re-returning the last page instead of an empty one once
     * `offset` runs past the genre's real song count instead of stopping
     * (navidrome/navidrome#1640). That combination turns any genre over 500
     * songs into an infinite pagination loop that hammers the server until
     * it (or the proxy in front of it) falls over with a 502. */
    async fetchSongsByGenre(genre: string): Promise<Track[]> {
      await this.fetchAllTracks()
      return this.allTracks.filter((track) => track.genre === genre)
    },

    /** The complete track catalog — used by TracksView so filtering/sorting
     * (e.g. "most played") works across the whole library, not just
     * whatever page happened to be loaded. search3 with an empty query is
     * the pragmatic flat-song-browse stand-in (no dedicated endpoint
     * exists) and, unlike getSongsByGenre, doesn't hit a server-side cap
     * below the count requested (verified: 20k+ songs in one call).
     * Rendering still needs to be paginated client-side by the view.
     *
     * Two paths, because a 20k+-song library rarely changes between app
     * launches but takes several sequential requests to fetch in full:
     *  - Warm cache (localStorage, see loadTracksCache()): shown instantly,
     *    then quietly re-fetched in full underneath and swapped in one
     *    atomic replace once done — a no-op visually unless the library
     *    actually changed, so it never reshuffles what's already on screen.
     *  - Cold cache (first-ever load): fetched page by page instead, each
     *    page appended as it arrives — the first page runs inside
     *    withLoading() (drives TracksView's skeleton), the rest streams in
     *    quietly, so the view is usable almost immediately instead of
     *    blocking on the entire catalog. TrackList keeps this stretch in
     *    stable arrival order (see its defaultSortKey watcher) so rows
     *    don't jump around while more of it streams in. */
    async fetchAllTracks(): Promise<void> {
      if (this.allTracksLoaded) return
      // Dedupe concurrent callers (see fetchAllTracksPromise's comment) —
      // they all await the same in-flight fetch instead of each starting
      // their own.
      if (fetchAllTracksPromise) return fetchAllTracksPromise
      fetchAllTracksPromise = this.fetchAllTracksNow().finally(() => {
        fetchAllTracksPromise = null
      })
      return fetchAllTracksPromise
    },

    async fetchAllTracksNow(): Promise<void> {
      const PAGE_SIZE = 3000
      const client = this.client()

      const cached = loadLibraryCache().tracks
      if (cached) {
        this.allTracks = cached
        this.allTracksLoaded = true
        fetchTrackPages(client, PAGE_SIZE)
          .then((fresh) => {
            this.allTracks = fresh
            saveLibraryCacheField('tracks', fresh)
          })
          .catch((error) => {
            console.error('[library] Background track catalog refresh failed:', error)
          })
        return
      }

      const first = await this.withLoading(() => client.search3('', PAGE_SIZE, 0, 0, 0))
      this.allTracks = first.tracks
      if (first.tracks.length < PAGE_SIZE) {
        this.allTracksLoaded = true
        saveLibraryCacheField('tracks', this.allTracks)
        return
      }
      try {
        let offset = PAGE_SIZE
        while (true) {
          const page = await client.search3('', PAGE_SIZE, 0, 0, offset)
          if (page.tracks.length === 0) break
          this.allTracks.push(...page.tracks)
          if (page.tracks.length < PAGE_SIZE) break
          offset += PAGE_SIZE
        }
        this.allTracksLoaded = true
        saveLibraryCacheField('tracks', this.allTracks)
      } catch (error) {
        // Whatever loaded so far stays usable — allTracksLoaded stays false
        // so leaving and revisiting /tracks retries from scratch instead of
        // being stuck with a silently incomplete catalog forever.
        console.error('[library] Failed to load the rest of the track catalog:', error)
      }
    },

    /** `force` skips the cache entirely — used right after a mutation
     * (createPlaylist()) that needs the real, current list back, not
     * whatever was last cached. */
    async fetchPlaylists(force = false): Promise<void> {
      if (force) {
        await this.withLoading(async () => {
          this.playlists = await this.client().getPlaylists()
          saveLibraryCacheField('playlists', this.playlists)
        })
        return
      }
      await cachedFetch(
        this,
        'playlists',
        () => this.client().getPlaylists(),
        (playlists) => (this.playlists = playlists),
      )
    },

    async fetchPlaylist(id: string): Promise<Playlist> {
      return this.withLoading(async () => this.client().getPlaylist(id))
    },

    async createPlaylist(name: string, songIds: string[] = []): Promise<void> {
      await this.withLoading(async () => {
        await this.client().createPlaylist(name, songIds)
        await this.fetchPlaylists(true)
      })
    },

    async addToPlaylist(playlistId: string, songIds: string[]): Promise<void> {
      await this.withLoading(async () => {
        await this.client().addToPlaylist(playlistId, songIds)
      })
    },

    async deletePlaylist(id: string): Promise<void> {
      await this.withLoading(async () => {
        await this.client().deletePlaylist(id)
        this.playlists = this.playlists.filter((p) => p.id !== id)
      })
    },

    async search(query: string): Promise<void> {
      if (!query.trim()) {
        this.searchResults = { artists: [], albums: [], tracks: [] }
        return
      }
      await this.withLoading(async () => {
        const result = await this.client().search3(query)
        this.searchResults = result
      })
    },

    async fetchStarred(): Promise<void> {
      await this.withLoading(async () => {
        this.starred = await this.client().getStarred2()
      })
    },

    async toggleStar(target: {
      id?: string
      albumId?: string
      artistId?: string
      starred: boolean
    }): Promise<void> {
      const client = this.client()
      const params = { id: target.id, albumId: target.albumId, artistId: target.artistId }
      if (target.starred) {
        await client.unstar(params)
      } else {
        await client.star(params)
      }
      await this.fetchStarred()
    },

    /** Sets a song/album/artist's 1–5 star rating (0 clears it) — the
     * caller owns optimistic local state (same pattern as toggleStar's
     * callers), since this can target a Track, Album, or Artist and there's
     * no single place in state to reconcile all three against. */
    async setRating(id: string, rating: number): Promise<void> {
      await this.client().setRating(id, rating)
    },

    async fetchRadioStations(): Promise<void> {
      await this.withLoading(async () => {
        this.radioStations = await this.client().getInternetRadioStations()
      })
    },

    async saveRadioStation(name: string, streamUrl: string, homePageUrl = ''): Promise<void> {
      await this.withLoading(async () => {
        await this.client().createInternetRadioStation(name, streamUrl, homePageUrl)
        await this.fetchRadioStations()
      })
    },

    async deleteRadioStation(id: string): Promise<void> {
      await this.withLoading(async () => {
        await this.client().deleteInternetRadioStation(id)
        this.radioStations = this.radioStations.filter((r) => r.id !== id)
      })
    },
  },
})
