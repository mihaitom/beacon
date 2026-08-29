<template>
  <router-link :to="`/m/playlists/${playlist.id}`" class="mobile-playlist-row d-flex align-center">
    <cover-art
      :cover-art-id="playlist.coverArtId"
      :size="52"
      fallback-icon="mdi-playlist-music"
      class="mr-3 flex-shrink-0"
    />
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-large text-truncate">{{ playlist.name }}</div>
      <div class="text-body-small text-medium-emphasis text-truncate">{{ meta }}</div>
    </div>
    <!-- Always visible — no hover state to reveal it on touch (this is what
     - made the desktop PlaylistRow.vue unusable here, see the mobile plan's
     - reusability research). -->
    <v-btn
      icon="mdi-play-circle"
      variant="text"
      size="small"
      color="primary"
      :title="$t('library.play')"
      @click.prevent.stop="$emit('play', playlist)"
    />
  </router-link>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import type { Playlist } from '@/types/library'

export default {
  name: 'MobilePlaylistRow',
  components: { CoverArt },
  props: {
    playlist: {
      type: Object as () => Playlist,
      required: true,
    },
    showOwner: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play'],
  computed: {
    meta(): string {
      const count = this.$t('playlists.songCount', { count: this.playlist.songCount })
      const duration = this.formatDuration(this.playlist.duration)
      const parts = [count, duration].filter(Boolean)
      if (this.showOwner && this.playlist.owner) {
        parts.push(this.$t('playlists.byOwner', { owner: this.playlist.owner }) as string)
      }
      return parts.join(' · ')
    },
  },
  methods: {
    formatDuration(seconds: number): string {
      if (!seconds) return ''
      const total = Math.round(seconds)
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      if (hours > 0) return this.$t('playlists.durationHours', { hours, minutes })
      return this.$t('playlists.durationMinutes', { minutes })
    },
  },
}
</script>

<style scoped>
.mobile-playlist-row {
  display: flex;
  padding: 10px 4px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}

.min-width-0 {
  min-width: 0;
}
</style>
