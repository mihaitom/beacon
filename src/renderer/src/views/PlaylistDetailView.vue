<template>
  <v-container v-if="playlist" fluid>
    <detail-header
      :cover-art-id="playlist.coverArtId"
      :size="200"
      fallback-icon="mdi-playlist-music"
      :eyebrow="$t('library.playlist')"
      :title="playlist.name"
    >
      <template #meta>
        {{ $t('playlists.songCount', { count: playlist.songCount }) }}
        <template v-if="durationLabel"> · {{ durationLabel }}</template>
      </template>
      <template #actions>
        <v-btn
          color="primary"
          rounded="pill"
          prepend-icon="mdi-play"
          :disabled="!playlist.tracks.length"
          @click="playAll"
        >
          {{ $t('library.play') }}
        </v-btn>
      </template>
      <template #top-right>
        <v-btn icon="mdi-delete-outline" variant="text" @click="remove" />
      </template>
    </detail-header>

    <track-list
      :tracks="playlist.tracks"
      :queue-whole-list="false"
      :default-sort-key="null"
      show-cover
      show-album
      show-genre
      show-year
      show-play-count
      show-format
    />
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
import DetailHeader from '@/components/library/DetailHeader.vue'
import TrackList from '@/components/library/TrackList.vue'
import PageLoader from '@/components/PageLoader.vue'

export default {
  name: 'PlaylistDetailView',
  components: { DetailHeader, TrackList, PageLoader },
  data() {
    return {
      playlist: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>> | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    durationLabel(): string {
      const seconds = this.playlist?.duration
      if (!seconds) return ''
      const total = Math.round(seconds)
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      if (hours > 0) return this.$t('playlists.durationHours', { hours, minutes })
      return this.$t('playlists.durationMinutes', { minutes })
    },
  },
  created() {
    this.loadPlaylist()
  },
  watch: {
    '$route.params.id': 'loadPlaylist',
  },
  methods: {
    async loadPlaylist() {
      const id = this.$route.params.id as string
      try {
        const playlist = await this.libraryStore.fetchPlaylist(id)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.$route.params.id === id) this.playlist = playlist
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[playlist-detail] Failed to load playlist:', error)
      }
    },
    async remove() {
      await this.libraryStore.deletePlaylist(this.$route.params.id as string)
      this.$router.push('/playlists')
    },
    async playAll() {
      if (!this.playlist?.tracks.length) return
      await usePlaybackStore().playTrackList(this.playlist.tracks, 0)
    },
  },
}
</script>
