<template>
  <router-link :to="`/m/playlists/${playlist.id}`" class="mobile-playlist-row mobile-row">
    <cover-art
      :cover-art-id="playlist.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      fallback-icon="mdi-playlist-music"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium">{{ playlist.name }}</div>
      <div class="text-body-small text-medium-emphasis">{{ meta }}</div>
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
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import type { Playlist } from '@/types/library'

export default {
  name: 'MobilePlaylistRow',
  components: { CoverArt },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
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
  text-decoration: none;
  color: inherit;
}
</style>
