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

    <section v-if="topTracks.length || loadingTopTracks" class="mb-10">
      <div class="d-flex align-center mb-4">
        <h2 class="section-title">{{ $t('home.topTracks') }}</h2>
        <v-btn
          v-if="topTracks.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          density="comfortable"
          :title="$t('home.playAll')"
          @click="playTrackList(topTracks)"
        />
      </div>
      <track-list
        :tracks="topTracks"
        :loading="loadingTopTracks"
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
          @click="rerollDiscover"
        />
      </template>
    </album-shelf>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import HeroBand from '@/components/home/HeroBand.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import TrackList from '@/components/library/TrackList.vue'
import type { Album, Track } from '@/types/library'

export default {
  name: 'HomeView',
  components: { HeroBand, AlbumShelf, TrackList },
  data() {
    return {
      frequentAlbums: [] as Album[],
      newestAlbums: [] as Album[],
      recentAlbums: [] as Album[],
      randomAlbums: [] as Album[],
      topTracks: [] as Track[],
      loadingFrequent: false,
      loadingNewest: false,
      loadingRecent: false,
      loadingRandom: false,
      loadingTopTracks: false,
      // Which shelf's "play all" is currently fetching album track lists —
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
    greeting() {
      const hour = new Date().getHours()
      const name = this.authStore.username
      if (hour < 5 || hour >= 22) return this.$t('home.greetingNight', { name })
      if (hour < 11) return this.$t('home.greetingMorning', { name })
      if (hour < 18) return this.$t('home.greetingDay', { name })
      return this.$t('home.greetingEvening', { name })
    },
    heroCoverId() {
      if (this.playbackStore.currentTrack) return this.playbackStore.currentTrack.coverArtId
      return this.recentAlbums[0]?.coverArtId ?? null
    },
    heroEyebrow() {
      if (this.playbackStore.currentTrack) {
        return this.playbackStore.isPlaying ? this.$t('home.nowPlaying') : this.$t('home.paused')
      }
      if (this.playbackStore.radioStation) return this.$t('home.radioEyebrow')
      return this.recentAlbums[0] ? this.$t('home.recentlyPlayed') : ''
    },
    heroTitle() {
      if (this.playbackStore.currentTrack) return this.playbackStore.currentTrack.title
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
      const track = this.playbackStore.currentTrack
      if (track) return track.artist
      if (this.playbackStore.radioStation) return null
      return this.recentAlbums[0]?.artist ?? null
    },
    heroArtistId(): string | null {
      const track = this.playbackStore.currentTrack
      if (track) return track.artistId
      if (this.playbackStore.radioStation) return null
      return this.recentAlbums[0]?.artistId ?? null
    },
    // Only the currently-playing-track case has a distinct album to name
    // alongside the artist (subtitle reads "Artist · Album") — the
    // fallback case's subtitle is just the artist, since the album is
    // already what the title itself names (and links to, see heroTitleTo).
    heroAlbumName(): string | null {
      return this.playbackStore.currentTrack?.album ?? null
    },
    heroAlbumId(): string | null {
      return this.playbackStore.currentTrack?.albumId ?? null
    },
    heroIsPlaying() {
      return this.playbackStore.isPlaying
    },
    heroHasContent() {
      return !!(
        this.playbackStore.currentTrack ||
        this.playbackStore.radioStation ||
        this.recentAlbums[0]
      )
    },
    // Nothing to show yet either way — only true during the initial
    // recentAlbums fetch, and only when there isn't already something
    // playing (which the hero can show immediately, no fetch needed).
    heroLoading() {
      if (this.playbackStore.currentTrack || this.playbackStore.radioStation) return false
      return this.loadingRecent
    },
  },
  created() {
    this.loadingFrequent = true
    this.libraryStore
      .fetchFrequentAlbums(30)
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

    this.rerollDiscover()

    this.loadingTopTracks = true
    this.libraryStore
      .fetchTopTracks(10)
      .then((tracks) => (this.topTracks = tracks))
      .finally(() => (this.loadingTopTracks = false))
  },
  methods: {
    rerollDiscover() {
      this.loadingRandom = true
      this.libraryStore
        .fetchRandomAlbums(15)
        .then((albums) => (this.randomAlbums = albums))
        .finally(() => (this.loadingRandom = false))
    },
    async onHeroPlay() {
      if (this.playbackStore.currentTrack) {
        await this.playbackStore.togglePlay()
        return
      }
      const album = this.recentAlbums[0]
      if (!album) return
      const full = await this.libraryStore.fetchAlbum(album.id)
      await this.playbackStore.playTrackList(full.tracks, 0)
    },
    async playTrackList(tracks: Track[]) {
      if (!tracks.length) return
      await this.playbackStore.playTrackList(tracks, 0)
    },
    // AlbumShelf.vue's album cards only ever carry list-level Album data
    // (no track list — see fetchAlbum()'s own comment), so "play all" for a
    // shelf means fetching each album's full track list first. Concatenated
    // in shelf order, album by album, rather than interleaved — that's the
    // order the shelf itself already reads in.
    async playAllAlbums(albums: Album[], shelfKey: string) {
      if (!albums.length || this.playingAllShelf) return
      this.playingAllShelf = shelfKey
      try {
        const fullAlbums = await Promise.all(albums.map((album) => this.libraryStore.fetchAlbum(album.id)))
        await this.playTrackList(fullAlbums.flatMap((album) => album.tracks))
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
