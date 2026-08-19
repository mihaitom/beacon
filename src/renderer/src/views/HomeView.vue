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
      @play="onHeroPlay"
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
      :loading="loadingRandom"
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
          :title="$t('home.reroll')"
          @click="rerollDiscover()"
        />
      </template>
    </album-shelf>

    <similar-artists-shelf :title="$t('home.newArtistsTitle')" :artists="newArtistDiscoveries" />
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
  type SimilarArtist,
} from '@/services/connect/recommendations'
import type { SimilarArtistDisplay } from '@/components/library/SimilarArtistsShelf.vue'
import HeroBand from '@/components/home/HeroBand.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import SimilarArtistsShelf from '@/components/library/SimilarArtistsShelf.vue'
import SongTable from '@/components/library/SongTable.vue'
import type { Album, Song } from '@/types/library'

// Below this many distinct seed artists, a similar-artist lookup isn't
// worth the round trip (and the very-first-launch/near-empty-library case
// would just seed from 1-2 artists, producing a "discover" shelf that's
// really just "more of the one thing you have") — falls back to the
// original random-albums behavior instead, same as the Settings toggle
// being off does.
const MIN_SEED_ARTISTS = 3
const MAX_SEED_ARTISTS = 5
const DISCOVER_SHELF_SIZE = 15
// Below this many owned matches, padding the shelf out with random albums
// reads better than a visibly sparse "discover" row.
const MIN_OWNED_MATCHES = 8

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
      loadingFrequent: false,
      loadingNewest: false,
      loadingRecent: false,
      loadingRandom: false,
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
    heroHasContent() {
      return !!(
        this.playbackStore.currentSong ||
        this.playbackStore.radioStation ||
        this.recentAlbums[0]
      )
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
    // Up to MAX_SEED_ARTISTS distinct artist names from `albums`, in the
    // order they appear — the frontend-side half of "seed from what's
    // actually been played", the backend half being
    // core/recommendations.py's get_similar_artists() not knowing or
    // caring where its seed names came from.
    pickSeedArtistNames(albums: Album[]): string[] {
      const seen = new Set<string>()
      const names: string[] = []
      for (const album of albums) {
        const key = album.artist.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        names.push(album.artist)
        if (names.length >= MAX_SEED_ARTISTS) break
      }
      return names
    },
    /** Discover shelf — real similar-artist suggestions (ListenBrainz, via
     * connect) when there's enough to seed from and the user hasn't opted
     * out (see stores/recommendations.ts), falling back to today's plain
     * random albums otherwise (too few seed artists, the toggle's off, or
     * the lookup itself failed — connect being unreachable shouldn't break
     * Home). `seedAlbums`, given (only by created()'s own initial call),
     * reuses frequentAlbums' already-in-flight fetch instead of this
     * re-requesting it — the manual reroll button (template's own
     * @click="rerollDiscover") calls this with no argument, falling back
     * to this.frequentAlbums, which is already populated by then. */
    async rerollDiscover(seedAlbums?: Album[]): Promise<void> {
      this.loadingRandom = true
      try {
        const albums = seedAlbums ?? this.frequentAlbums
        const seedNames = this.pickSeedArtistNames(albums)
        if (this.recommendationsStore.enabled && seedNames.length >= MIN_SEED_ARTISTS) {
          try {
            await this.discoverFromSimilarArtists(seedNames)
            return
          } catch (error) {
            console.error('[home] Similar-artist discover failed, falling back to random:', error)
          }
        }
        this.newArtistDiscoveries = []
        this.randomAlbums = await this.libraryStore.fetchRandomAlbums(DISCOVER_SHELF_SIZE)
      } finally {
        this.loadingRandom = false
      }
    },
    /** The actual ListenBrainz-backed half of rerollDiscover() — split out
     * so that method's own try/catch has one call to wrap, instead of this
     * whole multi-step pipeline living inline inside it. Partitions the
     * result into albums to actually show (an owned artist's own album,
     * fetched via fetchArtist() since the list-level Artist entries
     * fetchArtists() already loaded never carry a full album list — same
     * "list vs. detail" split as fetchAlbum()'s own comment) and
     * newArtistDiscoveries (everything not in the library at all). */
    async discoverFromSimilarArtists(seedNames: string[]): Promise<void> {
      await this.libraryStore.fetchArtists()
      // No explicit limit — relies on getSimilarArtists()'s own default
      // (100, matching the backend's), not a smaller number picked here.
      // A broad library already owns most of the top-scoring matches, so
      // the pool has to start wide for enough to survive the "not owned"
      // partition below.
      const similar = await getSimilarArtists(seedNames)

      const owned: Album[] = []
      const notOwned: SimilarArtist[] = []
      for (const artist of similar) {
        const match = this.libraryStore.artists.find(
          (a) => a.name.toLowerCase() === artist.name.toLowerCase(),
        )
        if (!match) {
          notOwned.push(artist)
          continue
        }
        const full = await this.libraryStore.fetchArtist(match.id)
        if (full.albums.length) {
          owned.push(full.albums[Math.floor(Math.random() * full.albums.length)]!)
        }
      }

      const notOwnedCapped = notOwned.slice(0, 20)
      // Deezer photo + a real artist page (falls back to the MusicBrainz
      // link already on hand when Deezer has no exact-name match — see
      // getArtistImages()) — best-effort, a lookup failure here shouldn't
      // blank out the whole shelf, just leave it image-less.
      let images: Awaited<ReturnType<typeof getArtistImages>> = {}
      try {
        images = await getArtistImages(notOwnedCapped.map((a) => a.name))
      } catch (error) {
        console.error('[home] Artist image lookup failed:', error)
      }
      this.newArtistDiscoveries = notOwnedCapped.map((artist) => {
        const enrichment = images[artist.name]
        return {
          ...artist,
          imageUrl: enrichment?.image ?? null,
          link: enrichment?.link ?? `https://musicbrainz.org/artist/${artist.mbid}`,
        }
      })
      const capped = owned.slice(0, DISCOVER_SHELF_SIZE)
      this.randomAlbums =
        capped.length >= MIN_OWNED_MATCHES
          ? capped
          : [
              ...capped,
              ...(await this.libraryStore.fetchRandomAlbums(DISCOVER_SHELF_SIZE - capped.length)),
            ]
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
      await this.playbackStore.playSongList(full.songs, 0, false)
    },
    async playSongList(songs: Song[]) {
      if (!songs.length) return
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      await this.playbackStore.playSongList(songs, 0, false)
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
