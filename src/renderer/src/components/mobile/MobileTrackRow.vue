<template>
  <div class="mobile-track-row d-flex align-center" :class="{ 'mobile-track-row--current': isCurrentTrack }" @click="$emit('play')">
    <cover-art :cover-art-id="track.coverArtId" :size="44" class="mr-3 flex-shrink-0" />
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-2 text-truncate" :class="{ 'text-primary': isCurrentTrack }">{{ track.title }}</div>
      <div class="text-caption text-medium-emphasis text-truncate">{{ track.artist }}</div>
    </div>
    <v-btn
      v-if="authStore.capabilities.favorites"
      :icon="track.starred ? 'mdi-heart' : 'mdi-heart-outline'"
      :color="track.starred ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      size="small"
      @click.stop="$emit('toggle-star')"
    />
    <v-btn icon="mdi-dots-vertical" variant="text" density="comfortable" size="small" @click.stop="$emit('open-actions')" />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'MobileTrackRow',
  components: { CoverArt },
  props: {
    track: {
      type: Object,
      required: true,
    },
  },
  emits: ['play', 'toggle-star', 'open-actions'],
  computed: {
    authStore() {
      return useAuthStore()
    },
    isCurrentTrack() {
      return usePlaybackStore().currentTrack?.id === this.track.id
    },
  },
}
</script>

<style scoped>
.mobile-track-row {
  min-height: 60px;
  padding: 4px;
  border-radius: 8px;
}

.mobile-track-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.min-width-0 {
  min-width: 0;
}
</style>
