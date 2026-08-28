<template>
  <v-container fluid class="home-view">
    <hero-band
      :greeting="greeting"
      :cover-id="heroCoverId"
      :eyebrow="heroEyebrow"
      :title="heroTitle"
      :title-to="heroTitleTo"
      :subtitle="heroSubtitle"
      :artist-name="heroArtistName"
      :artist-id="heroArtistId"
      :album-name="heroAlbumName"
      :album-id="heroAlbumId"
      :is-playing-this="heroIsPlaying"
      :has-content="heroHasContent"
      :loading="heroLoading"
      :can-start-radio="heroCanStartRadio"
      :radio-loading="heroRadioLoading"
      @play="onHeroPlay"
      @song-radio="onHeroSongRadio"
    />

    <album-shelf
      :title="$t('home.frequentlyPlayed')"
      :albums="frequentAlbums"
      :loading="loadingFrequent"
      :play-all-loading="playingAllShelf === 'frequent'"
      play-on-click
      @play-all="playAllAlbums(frequentAlbums, 'frequent')"
    />

    <section v-if="topSongs.length || loadingTopSongs" class="mb-10">
      <div class="d-flex align-center mb-4">
        <h2 class="section-title">{{ $t('home.topSongs') }}</h2>
        <v-btn
          v-if="topSongs.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          density="comfortable"
          :title="$t('home.playAll')"
          @click="playSongList(topSongs)"
        />
      </div>
      <song-table
        :songs="topSongs"
        :loading="loadingTopSongs"
        default-sort-key="playCount"
        default-sort-direction="desc"
        show-cover
        show-album
        show-play-count
      />
    </section>

    <album-shelf
      :title="$t('home.recentlyAdded')"
      :albums="newestAlbums"
      :loading="loadingNewest"
      :play-all-loading="playingAllShelf === 'newest'"
      play-on-click
      @play-all="playAllAlbums(newestAlbums, 'newest')"
    />
    <album-shelf
      :title="$t('home.recentlyPlayed')"
      :albums="recentAlbums"
      :loading="loadingRecent"
      :play-all-loading="playingAllShelf === 'recent'"
      play-on-click
      @play-all="playAllAlbums(recentAlbums, 'recent')"
    />

    <album-shelf
      :title="$t('home.discover')"
      :albums="randomAlbums"
      :loading="discoverAlbumsLoading"
      :play-all-loading="playingAllShelf === 'random'"
      fit-to-screen
      play-on-click
      @play-all="playAllAlbums(randomAlbums, 'random')"
    >
      <template #action>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :loading="discoverAlbumsLoading"
          :title="$t('home.reroll')"
          @click="rerollDiscover(undefined, true, 'albums')"
        />
      </template>
    </album-shelf>

    <similar-artists-shelf
      :title="$t('home.newArtistsTitle')"
      :artists="newArtistDiscoveries"
      :loading="discoverArtistsLoading"
    >
      <template #action>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :loading="discoverArtistsLoading"
          :title="$t('home.reroll')"
          @click="rerollDiscover(undefined, true, 'artists')"
        />
      </template>
    </similar-artists-shelf>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import { useRecommendationsStore } from '@/stores/recommendations'
import {
  getSimilarArtists,
  getArtistImages,
  getArtistLinksByMbid,
  type SimilarArtist,
} from '@/services/connect/recommendations'
import { type ExternalLinkKey } from '@/components/library/externalArtistLinks'
import type { SimilarArtistDisplay } from '@/components/library/SimilarArtistsShelf.vue'
import HeroBand from '@/components/home/HeroBand.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import SimilarArtistsShelf from '@/components/library/SimilarArtistsShelf.vue'
import SongTable from '@/components/library/SongTable.vue'
import type { Album, Artist, Song } from '@/types/library'

// Below this many distinct seed artists, a similar-artist lookup isn't
// worth the round trip (and the very-first-launch/near-empty-library case
// would just seed from 1-2 artists, producing a "discover" shelf that's
// really just "more of the one thing you have") — falls back to the
// original random-albums behavior instead, same as the Settings toggle
// being off does.
const MIN_SEED_ARTISTS = 3
const MAX_SEED_ARTISTS = 5
// 20, not some smaller row-of-a-few number: fitToScreen (see AlbumShelf.vue)
// already sizes the row to however many cards the viewport fits, so this
// just needs to be at least that many on a wide screen — matches
// notOwnedCapped's own 20 below, so neither shelf runs out before the
// other on a wide window.
const DISCOVER_SHELF_SIZE = 20
// Below this many owned matches, padding the shelf out with random albums
// reads better than a visibly sparse "discover" row.
const MIN_OWNED_MATCHES = 8

// Persists pickSeedArtistNames()'s last random pick (see its own comment)
// — localStorage, not just component state, since the whole point is
// surviving a fresh mount (navigating away from Home and back, an app
// restart), not just a reroll within one still-open session.
const SEED_CACHE_KEY = 'beacon.discover-seed-cache'

interface SeedCache {
  // Sorted, lowercased distinct artist names the pick was drawn from —
  // compared against the *current* pool to decide whether to reuse
  // `seeds` as-is or pick fresh ones, order-insensitive on purpose (a
  // frequent-albums re-ranking that doesn't change *which* artists are in
  // the pool shouldn't by itself count as "genuinely new data").
  pool: string[]
  seeds: string[]
}

function loadSeedCache(): SeedCache | null {
  try {
    const raw = localStorage.getItem(SEED_CACHE_KEY)
    return raw ? (JSON.parse(raw) as SeedCache) : null
  } catch {
    return null
  }
}

function saveSeedCache(cache: SeedCache): void {
  try {
    localStorage.setItem(SEED_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Non-critical — worst case just re-randomizes next load instead of
    // reusing this pick.
  }
}

function sameArtistPool(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

export default {
  name: 'HomeView',
  components: { HeroBand, AlbumShelf, SimilarArtistsShelf, SongTable },
  data() {
    return {
      frequentAlbums: [] as Album[],
      newestAlbums: [] as Album[],
      recentAlbums: [] as Album[],
      randomAlbums: [] as Album[],
      // Similar artists ListenBrainz suggested that aren't in the library
      // — see rerollDiscover(). Empty whenever the toggle's off, there
      // weren't enough seed artists, or the lookup itself failed; the
      // SimilarArtistsShelf component hides itself in all of those cases.
      newArtistDiscoveries: [] as SimilarArtistDisplay[],
      topSongs: [] as Song[],
      // Spinner on the hero's own Song Radio button while the mix is being
      // fetched — see onHeroSongRadio().
      heroRadioLoading: false,
      loadingFrequent: false,
      loadingNewest: false,
      loadingRecent: false,
      // Which of the two Discover shelves is currently waiting on a
      // lookup, or null. One field rather than two booleans: the lookup
      // fills both shelves in one go, so at most one of them can be the
      // one that asked — and it is also the only one that shows the wait.
      // Which of the two Discover shelves is waiting on the lookup.
      // 'both' is the initial load, where neither has anything yet —
      // without it the artists shelf had no loading state to show and
      // simply wasn't rendered until its first data arrived, appearing
      // out of nowhere below a page that had already settled.
      loadingDiscover: null as 'albums' | 'artists' | 'both' | null,
      // The half of a lookup the shelf that asked for it didn't use. One
      // lookup produces both halves (see discoverFromSimilarArtists), and
      // that whole chain — MusicBrainz, ListenBrainz, then Deezer photos
      // and links per artist — takes seconds. Keeping the other half means
      // the *other* shelf's next shuffle is instant, and it is still a
      // genuinely fresh set: it came from the seeds that lookup picked.
      // Used once, then gone, so a second shuffle of the same shelf is a
      // real lookup again.
      heldOverAlbums: null as Album[] | null,
      heldOverArtists: null as SimilarArtistDisplay[] | null,
      loadingTopSongs: false,
      // Which shelf's "play all" is currently fetching album song lists —
      // a single field (not one boolean per shelf) since only one of these
      // can realistically be in flight at a time (each is a user click).
      playingAllShelf: null as string | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    recommendationsStore() {
      return useRecommendationsStore()
    },
    greeting() {
      const hour = new Date().getHours()
      const name = this.authStore.username
      if (hour < 5 || hour >= 22) return this.$t('home.greetingNight', { name })
      if (hour < 11) return this.$t('home.greetingMorning', { name })
      if (hour < 18) return this.$t('home.greetingDay', { name })
      return this.$t('home.greetingEvening', { name })
    },
    heroCoverId() {
      if (this.playbackStore.currentSong) return this.playbackStore.currentSong.coverArtId
      return this.recentAlbums[0]?.coverArtId ?? null
    },
    heroEyebrow() {
      if (this.playbackStore.currentSong) {
        return this.playbackStore.isPlaying ? this.$t('home.nowPlaying') : this.$t('home.paused')
      }
      if (this.playbackStore.radioStation) return this.$t('home.radioEyebrow')
      return this.recentAlbums[0] ? this.$t('home.recentlyPlayed') : ''
    },
    heroTitle() {
      if (this.playbackStore.currentSong) return this.playbackStore.currentSong.title
      if (this.playbackStore.radioStation) return this.playbackStore.radioStation.name
      return this.recentAlbums[0]?.name ?? ''
    },
    // Always null — this used to link the "nothing playing, here's your
    // most recent album" fallback title to the album page, but that title
    // sits right next to the hero's own dedicated play button (which
    // already correctly starts that same album, see onHeroPlay()), so a
    // click there read as "play this" and instead navigated away. The
    // artist/album *subtitle* links (see HeroBand.vue) still navigate —
    // just not the big heading, which is the one thing already doubling as
    // "the thing the play button plays".
    heroTitleTo(): string | null {
      return null
    },
    // Plain-text-only fallback (HeroBand.vue only falls back to this when
    // heroArtistName is null, i.e. the radio case below).
    heroSubtitle() {
      if (this.playbackStore.radioStation) return this.$t('home.internetRadio')
      return ''
    },
    heroArtistName(): string | null {
      const song = this.playbackStore.currentSong
      if (song) return song.artist
      if (this.playbackStore.radioStation) return null
      return this.recentAlbums[0]?.artist ?? null
    },
    heroArtistId(): string | null {
      const song = this.playbackStore.currentSong
      if (song) return song.artistId
      if (this.playbackStore.radioStation) return null
      return this.recentAlbums[0]?.artistId ?? null
    },
    // Only the currently-playing-song case has a distinct album to name
    // alongside the artist (subtitle reads "Artist · Album") — the
    // fallback case's subtitle is just the artist, since the album is
    // already what the title itself names (and links to, see heroTitleTo).
    heroAlbumName(): string | null {
      return this.playbackStore.currentSong?.album ?? null
    },
    heroAlbumId(): string | null {
      return this.playbackStore.currentSong?.albumId ?? null
    },
    heroIsPlaying() {
      return this.playbackStore.isPlaying
    },
    // Song Radio needs an actual song to build the mix around, so this is
    // deliberately narrower than heroHasContent: the "here's your most
    // recent album" fallback has no single seed song, and an internet radio
    // station isn't in the library at all. Same capability gate every other
    // Song Radio entry point uses (SongRow.vue's menu, PlayerToolbar.vue's
    // autoplay button).
    heroCanStartRadio(): boolean {
      return this.authStore.capabilities.songRadio && this.playbackStore.currentSong != null
    },
    heroHasContent() {
      return !!(
        this.playbackStore.currentSong ||
        this.playbackStore.radioStation ||
        this.recentAlbums[0]
      )
    },
    discoverAlbumsLoading() {
      return this.loadingDiscover === 'albums' || this.loadingDiscover === 'both'
    },
    discoverArtistsLoading() {
      return this.loadingDiscover === 'artists' || this.loadingDiscover === 'both'
    },
    // Nothing to show yet either way — only true during the initial
    // recentAlbums fetch, and only when there isn't already something
    // playing (which the hero can show immediately, no fetch needed).
    heroLoading() {
      if (this.playbackStore.currentSong || this.playbackStore.radioStation) return false
      return this.loadingRecent
    },
  },
  created() {
    this.loadingFrequent = true
    const frequentPromise = this.libraryStore.fetchFrequentAlbums(30)
    frequentPromise
      .then((albums) => (this.frequentAlbums = albums))
      .finally(() => (this.loadingFrequent = false))

    this.loadingNewest = true
    this.libraryStore
      .client()
      .getAlbumList2('newest', 30)
      .then((albums: Album[]) => (this.newestAlbums = albums))
      .finally(() => (this.loadingNewest = false))

    this.loadingRecent = true
    this.libraryStore
      .fetchRecentlyPlayedAlbums(30)
      .then((albums) => (this.recentAlbums = albums))
      .finally(() => (this.loadingRecent = false))

    // fetchArtists() only to check which similar-artist suggestions are
    // already owned (see rerollDiscover()) — own cached request, a no-op
    // if some earlier view already populated it (matches StatsView.vue's
    // identical reasoning for its own topArtists artwork).
    this.libraryStore.fetchArtists()
    // Reuses frequentPromise's own result to seed rerollDiscover() instead
    // of each firing its own fetchFrequentAlbums() call — see that
    // method's own `seedAlbums` param.
    frequentPromise.then((albums) => this.rerollDiscover(albums))

    this.loadingTopSongs = true
    this.libraryStore
      .fetchTopSongs(10)
      .then((songs) => (this.topSongs = songs))
      .finally(() => (this.loadingTopSongs = false))
  },
  methods: {
    // A random MAX_SEED_ARTISTS-sized sample of the distinct artist names
    // in `albums` — the frontend-side half of "seed from what's actually
    // been played", the backend half being core/recommendations.py's
    // get_similar_artists() not knowing or caring where its seed names
    // came from. Randomized (a shuffle-then-take, not just always the
    // first N by frequent-album order, which is what this used to do) so
    // the Reroll button can actually reroll into something different —
    // but only a *new* random pick when `force` is set (an explicit Reroll
    // click) or the underlying pool has genuinely changed since the last
    // one (see SeedCache). Without that guard, every plain component
    // mount (navigating away from Home and back, an app restart) picked
    // its own fresh random seeds too, which defeated get_similar_artists()'s
    // own 24h cache almost entirely — different seeds each time meant a
    // real MusicBrainz/ListenBrainz round trip nearly every time, observed
    // live as a burst of MusicBrainz 503s under that load.
    pickSeedArtistNames(albums: Album[], force = false): string[] {
      const seen = new Set<string>()
      const names: string[] = []
      for (const album of albums) {
        const key = album.artist.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        names.push(album.artist)
      }
      const pool = [...seen].sort()

      if (!force) {
        const cached = loadSeedCache()
        if (cached && sameArtistPool(cached.pool, pool)) return cached.seeds
      }

      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[names[i], names[j]] = [names[j]!, names[i]!]
      }
      const seeds = names.slice(0, MAX_SEED_ARTISTS)
      saveSeedCache({ pool, seeds })
      return seeds
    },
    /** Discover shelf — real similar-artist suggestions (ListenBrainz, via
     * connect) when there's enough to seed from and the user hasn't opted
     * out (see stores/recommendations.ts), falling back to today's plain
     * random albums otherwise (too few seed artists, the toggle's off, or
     * the lookup itself failed — connect being unreachable shouldn't break
     * Home). `seedAlbums`, given (only by created()'s own initial call),
     * reuses frequentAlbums' already-in-flight fetch instead of this
     * re-requesting it — the manual reroll button (template's own
     * @click="rerollDiscover(undefined, true, 'albums')") calls this with
     * no seedAlbums, falling back to this.frequentAlbums (already
     * populated by then), and `force: true` so it actually picks something
     * new instead of reusing the cached seeds from before — see
     * pickSeedArtistNames()'s own comment.
     *
     * `only` is which shelf asked. One lookup fills both (see
     * discoverFromSimilarArtists), but replacing the shelf somebody
     * *didn't* touch is a surprise: they press shuffle under the new
     * artists and the albums above them change too, for no reason they
     * can see. The other half of the result is simply dropped. Null (the
     * initial load) takes both, since neither is showing anything yet. */
    async rerollDiscover(
      seedAlbums?: Album[],
      force = false,
      only: 'albums' | 'artists' | null = null,
    ): Promise<void> {
      // Spend the half kept back from the other shelf's last shuffle
      // before asking for anything new.
      if (only === 'artists' && this.heldOverArtists) {
        this.newArtistDiscoveries = this.heldOverArtists
        this.heldOverArtists = null
        return
      }
      if (only === 'albums' && this.heldOverAlbums) {
        this.randomAlbums = this.heldOverAlbums
        this.heldOverAlbums = null
        return
      }

      this.loadingDiscover = only ?? 'both'
      try {
        const albums = seedAlbums ?? this.frequentAlbums
        const seedNames = this.pickSeedArtistNames(albums, force)
        if (this.recommendationsStore.enabled && seedNames.length >= MIN_SEED_ARTISTS) {
          try {
            await this.discoverFromSimilarArtists(seedNames, only)
            return
          } catch (error) {
            console.error('[home] Similar-artist discover failed, falling back to random:', error)
          }
        }
        // The fallback has no artists to offer at all, so it only ever
        // touches the albums shelf — leaving whatever the artists shelf
        // already had rather than emptying it because an unrelated lookup
        // failed.
        if (only !== 'artists') {
          this.newArtistDiscoveries = only === null ? [] : this.newArtistDiscoveries
          this.randomAlbums = await this.libraryStore.fetchRandomAlbums(DISCOVER_SHELF_SIZE)
        }
      } finally {
        this.loadingDiscover = null
      }
    },
    /** One album from each owned artist among the matches, for the Discover
     * shelf. Resolved in parallel and only as far as the shelf can show:
     * this used to await a getArtist call per match, one after the other,
     * for a list that on a broad library routinely runs several times the
     * length of the shelf — the single biggest part of how long Home sat
     * on placeholders. An artist whose detail carries no albums simply
     * doesn't contribute, so this keeps taking batches until the shelf is
     * full or the matches run out. A match that fails to load is skipped
     * rather than taking the whole shelf down with it. */
    async albumsForOwnedArtists(matches: Artist[]): Promise<Album[]> {
      const picked: Album[] = []
      for (
        let from = 0;
        from < matches.length && picked.length < DISCOVER_SHELF_SIZE;
        from += DISCOVER_SHELF_SIZE
      ) {
        const batch = matches.slice(from, from + DISCOVER_SHELF_SIZE)
        const resolved = await Promise.allSettled(
          batch.map((match) => this.libraryStore.fetchArtist(match.id)),
        )
        for (const result of resolved) {
          if (result.status === 'rejected') {
            console.error('[home] Discover: artist lookup failed:', result.reason)
            continue
          }
          const albums = result.value.albums
          if (!albums.length) continue
          picked.push(albums[Math.floor(Math.random() * albums.length)]!)
          if (picked.length === DISCOVER_SHELF_SIZE) break
        }
      }
      return picked
    },
    /** The actual ListenBrainz-backed half of rerollDiscover() — split out
     * so that method's own try/catch has one call to wrap, instead of this
     * whole multi-step pipeline living inline inside it. Partitions the
     * result into albums to actually show (an owned artist's own album,
     * fetched via fetchArtist() since the list-level Artist entries
     * fetchArtists() already loaded never carry a full album list — same
     * "list vs. detail" split as fetchAlbum()'s own comment) and
     * newArtistDiscoveries (everything not in the library at all). */
    async discoverFromSimilarArtists(
      seedNames: string[],
      only: 'albums' | 'artists' | null = null,
    ): Promise<void> {
      // Side by side rather than one after the other: the artist list feeds
      // the partition below and the lookup is the long pole (a
      // MusicBrainz/ListenBrainz round trip whenever the backend's 24h
      // cache misses), and neither needs anything from the other. Waiting
      // out a cold artist cache first added its whole duration to how long
      // the shelves sat empty.
      //
      // No explicit limit on the lookup — relies on getSimilarArtists()'s
      // own default (100, matching the backend's), not a smaller number
      // picked here. A broad library already owns most of the top-scoring
      // matches, so the pool has to start wide for enough to survive the
      // "not owned" partition below.
      const [, similar] = await Promise.all([
        this.libraryStore.fetchArtists(),
        getSimilarArtists(seedNames),
      ])

      // Partitioning is pure bookkeeping against the list already in
      // memory — the requests it implies come after, so that both halves
      // can be fetched at once.
      const ownedMatches: Artist[] = []
      const notOwned: SimilarArtist[] = []
      for (const artist of similar) {
        const match = this.libraryStore.artists.find(
          (a) => a.name.toLowerCase() === artist.name.toLowerCase(),
        )
        if (match) ownedMatches.push(match)
        else notOwned.push(artist)
      }

      const notOwnedCapped = notOwned.slice(0, 20)
      // Deezer photo + link, and MusicBrainz's own page plus whichever of
      // Spotify/Apple Music/TIDAL/YouTube/Discogs it has on file (the same
      // set ArtistDetailView.vue shows for an owned artist) — two
      // independent lookups, Promise.allSettled so one failing doesn't
      // blank out what the other found. getArtistLinksByMbid(), not
      // getArtistLinks(): these artists already carry a trusted MBID
      // straight from ListenBrainz Labs (getSimilarArtists() above), so a
      // name-based lookup would just make the backend redundantly re-derive
      // one it doesn't need to.
      const [owned, [images, linksByMbid]] = await Promise.all([
        this.albumsForOwnedArtists(ownedMatches),
        Promise.allSettled([
          getArtistImages(notOwnedCapped.map((a) => a.name)),
          getArtistLinksByMbid(notOwnedCapped.map((a) => a.mbid)),
        ]),
      ])
      if (images.status === 'rejected') {
        console.error('[home] Artist image lookup failed:', images.reason)
      }
      if (linksByMbid.status === 'rejected') {
        console.error('[home] Artist links lookup failed:', linksByMbid.reason)
      }
      const discoveries = notOwnedCapped.map((artist) => {
        const enrichment = images.status === 'fulfilled' ? images.value[artist.name] : undefined
        const links: Partial<Record<ExternalLinkKey, string>> =
          linksByMbid.status === 'fulfilled' ? { ...linksByMbid.value[artist.mbid] } : {}
        if (enrichment?.link) links.deezer = enrichment.link
        // Same last-resort fallback as before this existed — a plain
        // MusicBrainz page link even when the by-mbid lookup above came
        // back empty (a transient failure, or genuinely nothing on file),
        // so there's always at least one way to reach the artist rather
        // than a discovery card with zero working links.
        if (!links.musicbrainz) links.musicbrainz = `https://musicbrainz.org/artist/${artist.mbid}`
        return {
          ...artist,
          imageUrl: enrichment?.image ?? null,
          links,
        }
      })
      const capped = owned.slice(0, DISCOVER_SHELF_SIZE)
      const albums =
        capped.length >= MIN_OWNED_MATCHES
          ? capped
          : [
              ...capped,
              ...(await this.libraryStore.fetchRandomAlbums(DISCOVER_SHELF_SIZE - capped.length)),
            ]

      // Both halves are computed either way — one lookup produced them.
      // The shelf that asked shows its half now; the other is kept for
      // that shelf's next shuffle (see heldOverAlbums/heldOverArtists)
      // rather than being thrown away or replacing a shelf nobody
      // touched.
      if (only !== 'albums') this.newArtistDiscoveries = discoveries
      else this.heldOverArtists = discoveries
      if (only !== 'artists') this.randomAlbums = albums
      else this.heldOverAlbums = albums
    },
    // Mirrors SongTable.vue's own startSongRadio() — same store action,
    // same toast on failure. The spinner lives on the button because the
    // mix is a real server round trip (getSimilarSongs2) that can take a
    // moment, and nothing else on screen would show it happening.
    async onHeroSongRadio() {
      const song = this.playbackStore.currentSong
      if (!song || this.heroRadioLoading) return
      this.heroRadioLoading = true
      try {
        await this.playbackStore.startSongRadio(song)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.songRadio'),
          message: this.$t('library.songRadioError'),
        })
        console.error('[song-radio]', error)
      } finally {
        this.heroRadioLoading = false
      }
    },
    async onHeroPlay() {
      if (this.playbackStore.currentSong) {
        await this.playbackStore.togglePlay()
        return
      }
      const album = this.recentAlbums[0]
      if (!album) return
      const full = await this.libraryStore.fetchAlbum(album.id)
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      await this.playbackStore.playSongList(full.songs, 0, false, full.songs.length > 1)
    },
    async playSongList(songs: Song[]) {
      if (!songs.length) return
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await this.playbackStore.playSongList(songs, 0, false, songs.length > 1)
    },
    // AlbumShelf.vue's album cards only ever carry list-level Album data
    // (no song list — see fetchAlbum()'s own comment), so "play all" for a
    // shelf means fetching each album's full song list first. Concatenated
    // in shelf order, album by album, rather than interleaved — that's the
    // order the shelf itself already reads in.
    async playAllAlbums(albums: Album[], shelfKey: string) {
      if (!albums.length || this.playingAllShelf) return
      this.playingAllShelf = shelfKey
      try {
        const fullAlbums = await Promise.all(
          albums.map((album) => this.libraryStore.fetchAlbum(album.id)),
        )
        await this.playSongList(fullAlbums.flatMap((album) => album.songs))
      } finally {
        this.playingAllShelf = null
      }
    },
  },
}
</script>

<style scoped>
.home-view {
  padding-bottom: 24px;
}
</style>
