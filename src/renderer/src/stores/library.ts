import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { SubsonicClient } from '@/services/subsonic/client'
import { accountScopedKey, getAccountKey } from '@/services/accountKey'
import {
  clearLibraryFields,
  LEGACY_CACHE_KEY,
  readLibraryField,
  writeLibraryField,
  type StoredLibraryField,
} from '@/services/library/libraryCacheStore'
import type { Album, Artist, Genre, Playlist, RadioStation, Song } from '@/types/library'

// Default cap for fetchTopSongsForArtist() below — exported so
// ArtistDetailView.vue's "Show all" toggle can tell whether an artist
// actually has more songs than that cap without duplicating the number.
export const TOP_SONGS_LIMIT = 10

// Dedupes concurrent fetchAllSongs() calls — fetchAlbum()'s derived path
// (and things that fan out into many fetchAlbum() calls at once, like
// fetchTopSongsForArtist()'s Promise.all) can all end up awaiting this at
// the same moment; without this they'd each see allSongsLoaded still false
// and kick off their own redundant parallel fetch of the whole catalog.
let fetchAllSongsPromise: Promise<void> | null = null

// How much of a search the results page asks for. Passed explicitly rather
// than left to SubsonicClient.search3()'s own 25-per-kind default, which is
// the API's convention for a type-ahead dropdown and far too small for a
// page: a common first name matches more than 25 tracks in any real
// library, and nothing on that page said the list had been cut short - it
// simply looked like everything the server had.
//
// Songs get the larger share because that is the list people scan; albums
// and artists are a handful of tiles above it. Still bounded, though, since
// this is one request whose whole answer is rendered at once - and a
// Jellyfin server splits a single shared limit across all three kinds (see
// media/jellyfin_bridge.py's search3), so asking for thousands would cost
// that answer its balance as well as its speed.
const SEARCH_SONG_LIMIT = 100
const SEARCH_ALBUM_LIMIT = 40
const SEARCH_ARTIST_LIMIT = 40

// The library data that's expensive to fetch in full but rarely changes
// between app launches. One record per kind (see
// services/library/libraryCacheStore.ts for why it is IndexedDB and no
// longer one localStorage blob), keyed per account.
type LibraryCacheField = 'songs' | 'artists' | 'albums' | 'playlists'

const CACHE_FIELDS: LibraryCacheField[] = ['songs', 'artists', 'albums', 'playlists']

interface LibraryCacheTypes {
  songs: Song
  artists: Artist
  albums: Album
  playlists: Playlist
}

// How long a cached field is used without a background refresh behind it.
//
// An hour for a Subsonic/Navidrome server, where re-fetching the catalog is
// a handful of quick calls. Far longer for Jellyfin, where it is not: its
// recursive Items query runs at roughly 9ms per item (see
// fetchAllSongsNow()), so a large library is minutes of scanning — paid on
// every app start that happens to fall outside the window, in the
// background, while the user is trying to browse. A library's contents do
// not change hourly, and the parts that do have their own paths: the manual
// rescan in Settings (invalidateCache()) and a forced fetchAlbums(true).
const CACHE_TTL_MS = 60 * 60 * 1000
const JELLYFIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function cacheTtl(): number {
  return useAuthStore().serverType === 'jellyfin' ? JELLYFIN_CACHE_TTL_MS : CACHE_TTL_MS
}

/** Per-account record key — song and album ids are only unique within one
 * media server, same reasoning as every other account-scoped store. */
function fieldKey(field: LibraryCacheField): string {
  const account = getAccountKey()
  return account ? `${account}::${field}` : field
}

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < cacheTtl()
}

async function readCacheField<K extends LibraryCacheField>(
  field: K,
): Promise<StoredLibraryField<LibraryCacheTypes[K]> | null> {
  await migrateLegacyCache()
  return readLibraryField<LibraryCacheTypes[K]>(fieldKey(field))
}

function saveLibraryCacheField<K extends LibraryCacheField>(
  field: K,
  value: LibraryCacheTypes[K][],
): void {
  writeLibraryField(fieldKey(field), value)
}

/** Moves an existing localStorage blob into the store, once per account per
 * app run, and takes the old key with it — without this, upgrading would
 * throw away a cache that costs minutes to rebuild on a Jellyfin server.
 * Each field keeps its real age, so one that was already stale still gets
 * its background refresh rather than looking freshly fetched. */
let migrationInFlight: Promise<void> | null = null

function migrateLegacyCache(): Promise<void> {
  // Deduped only while it is actually running, not remembered afterwards:
  // a finished migration leaves no key behind, so a later call is one
  // localStorage read that finds nothing. Remembering it instead would
  // mean the *next account* to log in never gets its own blob carried
  // over, since that key is account-scoped and this store outlives any one
  // login.
  if (!migrationInFlight) {
    migrationInFlight = runLegacyMigration().finally(() => {
      migrationInFlight = null
    })
  }
  return migrationInFlight
}

async function runLegacyMigration(): Promise<void> {
  const key = accountScopedKey(LEGACY_CACHE_KEY)
  let legacy: Record<string, unknown>
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    legacy = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const fetchedAt = (legacy.fetchedAt ?? {}) as Partial<Record<LibraryCacheField, number>>
  for (const field of CACHE_FIELDS) {
    const items = legacy[field]
    if (Array.isArray(items)) writeLibraryField(fieldKey(field), items, fetchedAt[field] ?? 0)
  }
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage disabled between the read and now — a later run would simply
    // copy the same fields again, which costs nothing.
  }
}

/** Called from authStore.logout() — a different account's library shouldn't
 * leak into whoever logs in next, same reasoning as clearPersistedPlayback(). */
export function clearLibraryCache(): Promise<void> {
  const cleared = clearLibraryFields(CACHE_FIELDS.map(fieldKey))
  try {
    localStorage.removeItem(accountScopedKey(LEGACY_CACHE_KEY))
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
  return cleared
}

/** Fetches every page of the flat song catalog (search3 with an empty
 * query) and returns it as one array — used for the cache-refresh path in
 * fetchAllSongs(), where nothing should touch reactive state until the
 * whole thing is done (see that method's comment for why). `onProgress`,
 * given, fires after each page — only refreshLibrary()'s manual "rescan"
 * trigger actually uses it (to drive a progress bar); the routine
 * background refresh ignores it, same as it ignores loaded/total either
 * way. `totalRecordCount` is only ever non-null when a Jellyfin bridge
 * answered (see SubsonicClient.search3()'s comment) — a real Subsonic/
 * Navidrome server leaves total unknown throughout. */
async function fetchSongPages(
  client: SubsonicClient,
  pageSize: number,
  onProgress?: (progress: { loaded: number; total: number | null }) => void,
): Promise<Song[]> {
  let all: Song[] = []
  let offset = 0
  while (true) {
    const page = await client.search3('', pageSize, 0, 0, offset)
    if (page.songs.length === 0) break
    all = all.concat(page.songs)
    onProgress?.({ loaded: all.length, total: page.totalRecordCount })
    if (page.songs.length < pageSize) break
    offset += pageSize
  }
  return all
}

/** Fetches the full album catalog page by page via getAlbumList2 — its own
 * request, deliberately not derived from allSongs. Deriving would mean
 * AlbumsView (a plain browse grid) has to wait for the entire song catalog
 * just to show album cards, which is a needless latency regression for
 * something getAlbumList2 already answers directly and quickly.
 *
 * `onPage`, given, fires after each page arrives — fetchAlbums() uses it to
 * render (and drop its loading skeleton for) the first page as soon as it's
 * in, instead of blocking on the whole catalog first. getAlbumList2 has no
 * total-count field to fan pages out in parallel, so this stays sequential
 * — on a large library (say 6000 albums / 12 pages at Subsonic's 500-item
 * page size), that used to mean the grid sat on a skeleton for as long as
 * *all twelve* round trips combined took, even though only the first page's
 * worth is needed to show anything at all. */
// How many album pages to have in flight at once, after the first.
//
// getAlbumList2 caps out at 500 albums per call, so a large library is a
// fixed number of round trips no matter what — 12 of them for 6000 albums.
// Waiting for each before asking for the next made that 12 times the
// latency of one: every page crosses the reverse proxy, connect, and the
// media server, and on a remote deployment that is a few hundred
// milliseconds each, all of it spent idle rather than working.
//
// Four, not more: this is the API, not artwork, so the burst is nothing
// like the one CoverArt.vue's own limit exists for (a dozen image fetches
// per screenful) — but it still crosses the same proxy, and four wide turns
// those 12 trips into 3 waves, which is most of the win. The cost of
// guessing wrong is bounded and small: the last wave asks for up to three
// pages past the end of the library, and an empty getAlbumList2 is the
// cheapest answer the server has.
const ALBUM_PAGE_CONCURRENCY = 4

async function fetchAlbumPages(
  client: SubsonicClient,
  pageSize: number,
  onPage?: (page: Album[]) => void,
): Promise<Album[]> {
  // The first page on its own: it is what paints the view (see
  // fetchAlbums()'s no-cache branch), so nothing else should be competing
  // with it, and until it comes back there is no way to know whether there
  // is a second one at all.
  const first = await client.getAlbumList2('alphabeticalByName', pageSize, 0)
  onPage?.(first)
  if (first.length < pageSize) return first

  const all = [...first]
  let offset = pageSize
  for (;;) {
    const wave = await Promise.all(
      Array.from({ length: ALBUM_PAGE_CONCURRENCY }, (_, index) =>
        client.getAlbumList2('alphabeticalByName', pageSize, offset + index * pageSize),
      ),
    )
    // Emitted in page order, not completion order — the list is
    // alphabetical, and the view appends what it is handed.
    for (const page of wave) {
      if (page.length === 0) return all
      all.push(...page)
      onPage?.(page)
      if (page.length < pageSize) return all
    }
    offset += ALBUM_PAGE_CONCURRENCY * pageSize
  }
}

/** Retries `fetcher` on failure, waiting `delayMs` between attempts — covers
 * transient failures right at app start (server/network/local proxy not
 * fully up yet), exactly the window cachedFetch()'s and fetchAllSongsNow()'s
 * background refresh run in. Without this, a single early failure leaves
 * whatever's already showing (stale cache, or nothing) stuck for the rest of
 * the session, since neither of those callers gets another chance to retry
 * on their own — see both functions below. */
async function withRetry<T>(fetcher: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetcher()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

/** Shows a cached value instantly (if there is one) while `fetcher` refreshes
 * it in the background — unless the cache is still within CACHE_TTL_MS, in
 * which case it's shown as-is with no refetch at all (see
 * LibraryCacheSnapshot.fetchedAt's comment for why this matters). Updates
 * both state (via `onResult`) and the cache once a refresh actually runs —
 * a no-op visually unless something actually changed since. Falls back to a
 * plain withLoading()-wrapped fetch (drives the caller's usual loading
 * spinner/skeleton) when there's no cache yet. */
async function cachedFetch<K extends LibraryCacheField>(
  store: { withLoading<R>(fn: () => Promise<R>): Promise<R> },
  field: K,
  fetcher: () => Promise<LibraryCacheTypes[K][]>,
  onResult: (value: LibraryCacheTypes[K][]) => void,
): Promise<void> {
  const cached = await readCacheField(field)
  if (cached) {
    onResult(cached.items)
    if (isFresh(cached.fetchedAt)) return
    withRetry(fetcher)
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
  allSongs: Song[]
  allSongsLoaded: boolean
  // Non-null only while refreshLibrary()'s manual "rescan" is actively
  // paging through the song catalog — drives SettingsView's progress bar.
  // `total` stays null on a real Subsonic/Navidrome server (no such
  // concept there — see SubsonicClient.search3()), so the UI falls back to
  // an indeterminate bar in that case.
  songScanProgress: { loaded: number; total: number | null } | null
  playlists: Playlist[]
  radioStations: RadioStation[]
  starred: { artists: Artist[]; albums: Album[]; songs: Song[] }
  searchResults: { artists: Artist[]; albums: Album[]; songs: Song[] }
  // Per-album cache for fetchAlbum() — list-level Album entries (from
  // fetchAlbums()/getAlbumList2) don't carry a full song list, so opening
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
    allSongs: [],
    allSongsLoaded: false,
    songScanProgress: null,
    playlists: [],
    radioStations: [],
    starred: { artists: [], albums: [], songs: [] },
    searchResults: { artists: [], albums: [], songs: [] },
    albumCache: {},
    artistCache: {},
    loadingCount: 0,
    error: null,
  }),

  getters: {
    loading: (state): boolean => state.loadingCount > 0,
    /** Derived from allSongs rather than its own fetch — every field a
     * Genre needs (name, songCount, distinct albumCount) is already right
     * there on each song, so a whole separate getGenres.view round trip
     * (and cache entry) would just be duplicating data we're loading
     * anyway. See fetchGenres(), which just makes sure allSongs is
     * populated first. */
    genres(state): Genre[] {
      const byName = new Map<string, { albumIds: Set<string>; songCount: number }>()
      for (const song of state.allSongs) {
        if (!song.genre) continue
        let entry = byName.get(song.genre)
        if (!entry) {
          entry = { albumIds: new Set(), songCount: 0 }
          byName.set(song.genre, entry)
        }
        entry.albumIds.add(song.albumId)
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
      return new SubsonicClient(auth.connectUrl, auth.credential, auth.connectToken, auth.sessionId)
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

    /** Called once a triggered Navidrome library scan finishes (see
     * SettingsView.vue) — a scan can add, remove, or re-tag songs
     * Beacon's own in-memory state has no way to hear about on its own.
     * fetchAlbums()/fetchArtists()/fetchAllSongs() each skip re-fetching
     * once their collection is non-empty (unlike fetchPlaylists(), which
     * already stale-while-revalidates via cachedFetch() every call — left
     * alone here), so clearing those specifically is what makes the next
     * visit to each view actually pick up what the scan changed instead of
     * serving Beacon's now-possibly-stale idea of the library until the
     * app restarts. Per-item caches (albumCache/artistCache) go too, since
     * a scan can change a specific album/artist's own song list without
     * that id ever having been "missing" before. */
    invalidateCache(): Promise<void> {
      const cleared = clearLibraryCache()
      this.artists = []
      this.albums = []
      this.allSongs = []
      this.allSongsLoaded = false
      this.albumCache = {}
      this.artistCache = {}
      return cleared
    },

    /** Called from authStore.logout() — without this, a different account
     * signing in afterwards would see the previous account's playlists,
     * radio stations, starred items, and search results, not just its
     * artists/albums/songs (which invalidateCache() above already
     * handles for the narrower "same-account rescan" case). This store is
     * a singleton for the app's whole lifetime, so nothing else clears it
     * between accounts. */
    resetForLogout(): void {
      clearLibraryCache()
      this.$reset()
    },

    /** Own request, own cache field — same stale-while-revalidate pattern as
     * fetchArtists()/fetchPlaylists(), fetching the whole catalog page by
     * page via getAlbumList2 (see fetchAlbumPages()). Deliberately NOT
     * derived from allSongs: that would force AlbumsView to wait on the
     * entire song catalog just to render a grid of album cards.
     *
     * The true first-ever-launch case (no cache at all yet) bypasses
     * cachedFetch()'s generic all-or-nothing withLoading() wrapper below —
     * see that branch's own comment for why. */
    async fetchAlbums(force = false): Promise<void> {
      if (!force && this.albums.length > 0) return
      // Same reasoning as fetchAllSongsNow()'s PAGE_SIZE — smaller pages
      // for Jellyfin mean a faster first paint.
      const ALBUM_PAGE_SIZE = useAuthStore().serverType === 'jellyfin' ? 200 : 500
      if (force) {
        await this.withLoading(async () => {
          this.albums = []
          await fetchAlbumPages(this.client(), ALBUM_PAGE_SIZE, (page) => {
            this.albums = this.albums.concat(page)
          })
          saveLibraryCacheField('albums', this.albums)
        })
        return
      }
      if (await readCacheField('albums')) {
        await cachedFetch(
          this,
          'albums',
          () => fetchAlbumPages(this.client(), ALBUM_PAGE_SIZE),
          (albums) => (this.albums = albums),
        )
        return
      }
      // No cache at all — a large library can mean several sequential
      // getAlbumList2 round trips (see fetchAlbumPages()'s comment, e.g. 12
      // for a 6000-album Subsonic library at 500/page); waiting on all of
      // them the way cachedFetch()'s withLoading() wrapper would leaves
      // AlbumsView's skeleton up for that whole combined time even though
      // one page is already enough to render something. Drops the loading
      // flag as soon as the first page is in instead; the rest fills in
      // reactively behind it, same as scrolling would load more anyway.
      let firstPageSeen = false
      this.loadingCount++
      this.error = null
      try {
        const fresh = await fetchAlbumPages(this.client(), ALBUM_PAGE_SIZE, (page) => {
          this.albums = firstPageSeen ? this.albums.concat(page) : page
          if (!firstPageSeen) {
            firstPageSeen = true
            this.loadingCount--
          }
        })
        saveLibraryCacheField('albums', fresh)
      } catch (error) {
        if (!firstPageSeen) {
          this.error = error instanceof Error ? error.message : String(error)
          throw error
        }
        // Something's already rendered (earlier pages succeeded) — same
        // "log it, don't blow away what's showing" treatment cachedFetch()
        // gives a failed background refresh.
        console.error('[library] Album page fetch failed partway through:', error)
      } finally {
        if (!firstPageSeen) this.loadingCount--
      }
    },

    /** List-level Album entries (from fetchAlbums()) never carry a full
     * song list, so opening a single album always needs its own
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

    async fetchArtists(force = false): Promise<void> {
      if (!force && this.artists.length > 0) return
      if (force) {
        await this.withLoading(async () => {
          this.artists = await this.client().getArtists()
          saveLibraryCacheField('artists', this.artists)
        })
        return
      }
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

    /** Every song by `artist`, across all their albums. `artist.albums` only
     * has real content when `artist` came from fetchArtist() (getArtist.view
     * nests full album summaries) — getArtists()' index/list form leaves it
     * empty, so a caller starting from a plain list-view Artist (e.g.
     * ArtistsView.vue's play-random) needs to fetchArtist() first. Fetches
     * each album's full song list via the same cache as fetchAlbum(), since
     * neither Subsonic endpoint returns song-level data for an artist
     * directly. */
    async fetchAllSongsForArtist(artist: Artist): Promise<Song[]> {
      const albums = await Promise.all(artist.albums.map((album) => this.fetchAlbum(album.id)))
      return albums.flatMap((album) => album.songs)
    },

    /** Top songs for an artist by local playCount, sorted descending.
     * ArtistDetailView.vue's own "Show all" toggle passes Infinity to lift
     * this default cap once the artist has more than TOP_SONGS_LIMIT. */
    async fetchTopSongsForArtist(artist: Artist, limit = TOP_SONGS_LIMIT): Promise<Song[]> {
      const songs = await this.fetchAllSongsForArtist(artist)
      return songs.sort((a, b) => b.playCount - a.playCount).slice(0, limit)
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

    /** Top songs across the whole library by local playCount. There's no
     * "most played songs" Subsonic endpoint, so this samples from the
     * frequently-played albums (already a playCount-sorted list) and
     * aggregates their songs — cheap (a handful of albums, using the same
     * fetchAlbum cache) compared to sorting the entire catalog for a
     * homepage widget. */
    async fetchTopSongs(limit = 10): Promise<Song[]> {
      return this.withLoading(async () => {
        const frequentAlbums = await this.client().getAlbumList2('frequent', 20)
        const albums = await Promise.all(frequentAlbums.map((album) => this.fetchAlbum(album.id)))
        return albums
          .flatMap((album) => album.songs)
          .sort((a, b) => b.playCount - a.playCount)
          .slice(0, limit)
      })
    },

    /** genres is derived from allSongs (see the getter above) — this just
     * makes sure that's actually loaded. */
    async fetchGenres(): Promise<void> {
      await this.fetchAllSongs()
    },

    /** Derived from allSongs, same as the genres getter above — deliberately
     * NOT getSongsByGenre.view, which Navidrome silently caps at 500 and,
     * worse, keeps re-returning the last page instead of an empty one once
     * `offset` runs past the genre's real song count instead of stopping
     * (navidrome/navidrome#1640). That combination turns any genre over 500
     * songs into an infinite pagination loop that hammers the server until
     * it (or the proxy in front of it) falls over with a 502. */
    async fetchSongsByGenre(genre: string): Promise<Song[]> {
      await this.fetchAllSongs()
      return this.allSongs.filter((song) => song.genre === genre)
    },

    /** The complete song catalog — used by SongsView so filtering/sorting
     * (e.g. "most played") works across the whole library, not just
     * whatever page happened to be loaded. search3 with an empty query is
     * the pragmatic flat-song-browse stand-in (no dedicated endpoint
     * exists) and, unlike getSongsByGenre, doesn't hit a server-side cap
     * below the count requested (verified: 20k+ songs in one call).
     * Rendering still needs to be paginated client-side by the view.
     *
     * Two paths, because a 20k+-song library rarely changes between app
     * launches but takes several sequential requests to fetch in full:
     *  - Warm cache (localStorage, see loadSongsCache()): shown instantly,
     *    then quietly re-fetched in full underneath and swapped in one
     *    atomic replace once done — a no-op visually unless the library
     *    actually changed, so it never reshuffles what's already on screen.
     *  - Cold cache (first-ever load): fetched page by page instead, each
     *    page appended as it arrives — the first page runs inside
     *    withLoading() (drives SongsView's skeleton), the rest streams in
     *    quietly, so the view is usable almost immediately instead of
     *    blocking on the entire catalog. SongTable keeps this stretch in
     *    stable arrival order (see its defaultSortKey watcher) so rows
     *    don't jump around while more of it streams in. */
    async fetchAllSongs(): Promise<void> {
      if (this.allSongsLoaded) return
      // Dedupe concurrent callers (see fetchAllSongsPromise's comment) —
      // they all await the same in-flight fetch instead of each starting
      // their own.
      if (fetchAllSongsPromise) return fetchAllSongsPromise
      fetchAllSongsPromise = this.fetchAllSongsNow().finally(() => {
        fetchAllSongsPromise = null
      })
      return fetchAllSongsPromise
    },

    async fetchAllSongsNow(): Promise<void> {
      // Jellyfin's recursive Items query (what search3.view is bridged to —
      // see connect/media/jellyfin_bridge.py) scales roughly linearly with
      // page size on at least one real server tested (~9ms/item), making a
      // 3000-item page take 25-35s there vs. under a second for Subsonic/
      // Navidrome. A much smaller page means the first real data shows up
      // in ~2s instead of ~30s — the rest still streams in progressively via
      // the .push() loop below either way, so total time to fully load a
      // very large library is about the same, just no longer spent staring
      // at an empty screen.
      const PAGE_SIZE = useAuthStore().serverType === 'jellyfin' ? 200 : 3000
      const client = this.client()

      const cached = await readCacheField('songs')
      if (cached) {
        this.allSongs = cached.items
        this.allSongsLoaded = true
        if (isFresh(cached.fetchedAt)) return
        withRetry(() => fetchSongPages(client, PAGE_SIZE))
          .then((fresh) => {
            this.allSongs = fresh
            saveLibraryCacheField('songs', fresh)
          })
          .catch((error) => {
            console.error('[library] Background song catalog refresh failed:', error)
          })
        return
      }

      const first = await this.withLoading(() => client.search3('', PAGE_SIZE, 0, 0, 0))
      this.allSongs = first.songs
      if (first.songs.length < PAGE_SIZE) {
        this.allSongsLoaded = true
        saveLibraryCacheField('songs', this.allSongs)
        return
      }
      try {
        let offset = PAGE_SIZE
        while (true) {
          const page = await client.search3('', PAGE_SIZE, 0, 0, offset)
          if (page.songs.length === 0) break
          this.allSongs.push(...page.songs)
          if (page.songs.length < PAGE_SIZE) break
          offset += PAGE_SIZE
        }
        this.allSongsLoaded = true
        saveLibraryCacheField('songs', this.allSongs)
      } catch (error) {
        // Whatever loaded so far stays usable — allSongsLoaded stays false
        // so leaving and revisiting /songs retries from scratch instead of
        // being stuck with a silently incomplete catalog forever.
        console.error('[library] Failed to load the rest of the song catalog:', error)
      }
    },

    /** Manual "rescan library" trigger (see SettingsView.vue) — unlike the
     * automatic paths above, always actually refetches regardless of
     * CACHE_TTL_MS, and reports progress via songScanProgress so the UI
     * can show a real bar instead of an indeterminate spinner. Mainly
     * useful for Jellyfin: the automatic background refresh already keeps
     * data eventually current, but only notices new music after
     * CACHE_TTL_MS (or the next full cold load) — this is for "I just
     * added an album and want Beacon to see it now." Albums/artists are
     * refetched too (force=true), just without their own progress bar —
     * on any server tested so far they're fast enough not to need one. */
    async refreshLibrary(): Promise<void> {
      const client = this.client()
      const PAGE_SIZE = useAuthStore().serverType === 'jellyfin' ? 200 : 3000
      this.songScanProgress = { loaded: 0, total: null }
      try {
        const fresh = await fetchSongPages(client, PAGE_SIZE, (progress) => {
          this.songScanProgress = progress
        })
        this.allSongs = fresh
        this.allSongsLoaded = true
        saveLibraryCacheField('songs', fresh)
      } finally {
        this.songScanProgress = null
      }
      await Promise.all([this.fetchAlbums(true), this.fetchArtists(true)])
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
        // Without this, PlaylistsView's list (and its cached songCount)
        // silently goes stale until something else happens to force a
        // refetch — same reasoning as createPlaylist()'s identical call.
        await this.fetchPlaylists(true)
      })
    },

    /** Persists a new song order (see the client's setPlaylistSongs()).
     * Deliberately outside withLoading(): the view has already moved the
     * row and reverts it itself if this throws, so flipping the shared
     * loading flag would only make the page it's on flash a loader over a
     * change that's already visible. Nothing cached needs updating either
     * — reordering changes neither songCount nor duration, and the songs
     * themselves are fetched fresh per visit (fetchPlaylist()). */
    async reorderPlaylist(playlistId: string, songIds: string[]): Promise<void> {
      await this.client().setPlaylistSongs(playlistId, songIds)
    },

    async updatePlaylist(id: string, updates: { name?: string; public?: boolean }): Promise<void> {
      await this.withLoading(async () => {
        await this.client().updatePlaylist(id, updates)
        const cached = this.playlists.find((p) => p.id === id)
        if (cached) {
          if (updates.name !== undefined) cached.name = updates.name
          if (updates.public !== undefined) cached.public = updates.public
          saveLibraryCacheField('playlists', this.playlists)
        }
      })
    },

    async deletePlaylist(id: string): Promise<void> {
      await this.withLoading(async () => {
        await this.client().deletePlaylist(id)
        this.playlists = this.playlists.filter((p) => p.id !== id)
        // Without this, PlaylistsView's next mount (e.g. right after this
        // same delete navigates back to it) reads the cache-first path in
        // cachedFetch() — which, within CACHE_TTL_MS, serves the stale
        // cached list straight back over this in-memory update, bringing
        // the just-deleted playlist right back until the cache happens to
        // go stale. createPlaylist()/updatePlaylist() already avoid this
        // (via fetchPlaylists(true) / their own saveLibraryCacheField
        // call); this was the one mutation missing it.
        saveLibraryCacheField('playlists', this.playlists)
      })
    },

    async search(query: string): Promise<void> {
      if (!query.trim()) {
        this.searchResults = { artists: [], albums: [], songs: [] }
        return
      }
      await this.withLoading(async () => {
        const result = await this.client().search3(
          query,
          SEARCH_SONG_LIMIT,
          SEARCH_ALBUM_LIMIT,
          SEARCH_ARTIST_LIMIT,
        )
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
     * callers), since this can target a Song, Album, or Artist and there's
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

    async updateRadioStation(
      id: string,
      name: string,
      streamUrl: string,
      homePageUrl = '',
    ): Promise<void> {
      await this.withLoading(async () => {
        await this.client().updateInternetRadioStation(id, name, streamUrl, homePageUrl)
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
