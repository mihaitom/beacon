<template>
  <v-container v-if="artist" fluid>
    <detail-header
      :cover-art-id="artist.coverArtId"
      :image-url="artist.imageUrl"
      :size="160"
      :eyebrow="$t('library.artist')"
      :title="artist.name"
      :starred="artist.starred"
      :rating="authStore.capabilities.personalRating ? artist.rating : null"
      @toggle-star="toggleStar"
      @set-rating="setRating"
    >
      <template #meta>
        {{ artist.albumCount }}
        {{ artist.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }} ·
        {{ totalTrackCount }}
        {{ totalTrackCount === 1 ? $t('library.track1') : $t('library.tracksN') }}
      </template>
      <template v-if="authStore.capabilities.trackRadio" #actions>
        <v-btn
          color="primary"
          rounded="pill"
          prepend-icon="mdi-radio-tower"
          @click="startArtistRadio"
        >
          {{ $t('library.artistRadio') }}
        </v-btn>
      </template>
    </detail-header>

    <div class="album-grid">
      <album-card v-for="album in artist.albums" :key="album.id" :album="album" />
    </div>

    <template v-if="topTracks.length || loadingTopTracks">
      <h2 class="section-title mt-8 mb-2">{{ $t('library.mostPlayed') }}</h2>
      <track-list
        :tracks="topTracks"
        :loading="loadingTopTracks"
        default-sort-key="playCount"
        default-sort-direction="desc"
        show-cover
        show-album
        show-genre
        show-year
        show-play-count
        show-format
      />
    </template>
  </v-container>
  <v-container v-else>
    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
      {{ libraryStore.error }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import DetailHeader from '@/components/library/DetailHeader.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import TrackList from '@/components/library/TrackList.vue'
import PageLoader from '@/components/PageLoader.vue'
import type { Track } from '@/types/library'

export default {
  name: 'ArtistDetailView',
  components: { DetailHeader, AlbumCard, TrackList, PageLoader },
  data() {
    return {
      artist: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchArtist']>> | null,
      topTracks: [] as Track[],
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
    totalTrackCount() {
      return this.artist?.albums.reduce((sum, album) => sum + album.songCount, 0) ?? 0
    },
  },
  created() {
    this.loadArtist()
  },
  watch: {
    '$route.params.id': 'loadArtist',
  },
  methods: {
    async loadArtist() {
      const id = this.$route.params.id as string
      this.topTracks = []
      // A newer navigation may resolve before this one, or move the route
      // on while a fetch is still in flight — the `$route.params.id === id`
      // checks below make sure a slower, now-stale response can't overwrite
      // whatever's actually being viewed by the time it arrives.
      let artist
      try {
        artist = await this.libraryStore.fetchArtist(id)
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[artist-detail] Failed to load artist:', error)
        return
      }
      if (this.$route.params.id !== id) return
      this.artist = artist

      this.loadingTopTracks = true
      try {
        const topTracks = await this.libraryStore.fetchTopTracksForArtist(artist)
        if (this.$route.params.id === id) this.topTracks = topTracks
      } catch (error) {
        if (this.$route.params.id === id) console.error('[artist-detail] Failed to load top tracks:', error)
      } finally {
        if (this.$route.params.id === id) this.loadingTopTracks = false
      }
    },
    async toggleStar() {
      if (!this.artist) return
      await this.libraryStore.toggleStar({ artistId: this.artist.id, starred: this.artist.starred })
      this.artist.starred = !this.artist.starred
    },
    async setRating(rating: number) {
      if (!this.artist) return
      const previous = this.artist.rating
      this.artist.rating = rating
      try {
        await this.libraryStore.setRating(this.artist.id, rating)
      } catch (error) {
        this.artist.rating = previous
        console.error('[artist-detail] Failed to set rating:', error)
      }
    },
    async startArtistRadio() {
      if (!this.artist) return
      try {
        await usePlaybackStore().startArtistRadio(this.artist)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.artistRadio'),
          message: this.$t('library.artistRadioError'),
        })
        console.error('[artist-radio]', error)
      }
    },
  },
}
</script>

<style scoped>
.album-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
</style>
