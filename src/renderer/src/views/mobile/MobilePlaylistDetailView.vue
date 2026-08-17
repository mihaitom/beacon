<template>
  <v-container v-if="playlist" fluid>
    <div class="d-flex align-center mb-4">
      <cover-art :cover-art-id="playlist.coverArtId" :size="72" fallback-icon="mdi-playlist-music" class="mr-3" />
      <div class="min-width-0 flex-grow-1">
        <h1 class="page-title text-truncate">{{ playlist.name }}</h1>
        <div class="text-caption text-medium-emphasis">
          {{ $t('playlists.songCount', { count: playlist.songCount }) }}
        </div>
      </div>
      <v-btn
        icon="mdi-play-circle"
        color="primary"
        size="large"
        variant="text"
        :disabled="!playlist.tracks.length"
        @click="playAll"
      />
    </div>

    <div class="mobile-playlist-detail__list">
      <mobile-track-row
        v-for="(track, index) in playlist.tracks"
        :key="track.id"
        :track="track"
        @play="play(index)"
        @toggle-star="toggleStar(track)"
        @open-actions="openActions(track)"
      />
    </div>

    <mobile-track-action-sheet v-model="actionsOpen" :track="activeTrack" />
  </v-container>
  <v-container v-else>
    <div v-if="libraryStore.loading" class="d-flex justify-center pa-6">
      <v-progress-circular indeterminate color="primary" />
    </div>
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">{{ libraryStore.error }}</v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import CoverArt from '@/components/library/CoverArt.vue'
import MobileTrackRow from '@/components/mobile/MobileTrackRow.vue'
import MobileTrackActionSheet from '@/components/mobile/MobileTrackActionSheet.vue'
import type { Track } from '@/types/library'

export default {
  name: 'MobilePlaylistDetailView',
  components: { CoverArt, MobileTrackRow, MobileTrackActionSheet },
  data() {
    return {
      playlist: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>> | null,
      actionsOpen: false,
      activeTrack: null as Track | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
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
        if (this.$route.params.id === id) this.playlist = playlist
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[mobile-playlist-detail] Failed to load playlist:', error)
      }
    },
    async playAll() {
      if (!this.playlist?.tracks.length) return
      await usePlaybackStore().playTrackList(this.playlist.tracks, 0)
    },
    async play(index: number) {
      if (!this.playlist) return
      await usePlaybackStore().playTrackList(this.playlist.tracks, index)
    },
    async toggleStar(track: Track) {
      await this.libraryStore.toggleStar({ id: track.id, starred: track.starred })
      track.starred = !track.starred
    },
    openActions(track: Track) {
      this.activeTrack = track
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-playlist-detail__list {
  display: flex;
  flex-direction: column;
}

.min-width-0 {
  min-width: 0;
}
</style>
