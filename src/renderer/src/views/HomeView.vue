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
    />

    <section v-if="topTracks.length || loadingTopTracks" class="mb-10">
      <h2 class="section-title mb-4">{{ $t('home.topTracks') }}</h2>
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
    />
    <album-shelf
      :title="$t('home.recentlyPlayed')"
      :albums="recentAlbums"
      :loading="loadingRecent"
    />

    <album-shelf
      :title="$t('home.discover')"
      :albums="randomAlbums"
      :loading="loadingRandom"
      fit-to-screen
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
    // Only the "nothing playing, here's your most recent album" fallback
    // names an album in the title itself (a *track* title, the other two
    // cases, has no page of its own to link to — see HeroBand.vue's
    // titleTo prop comment).
    heroTitleTo(): string | null {
      if (this.playbackStore.currentTrack || this.playbackStore.radioStation) return null
      const album = this.recentAlbums[0]
      return album ? `/albums/${album.id}` : null
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
  },
}
</script>

<style scoped>
.home-view {
  padding-bottom: 24px;
}
</style>
