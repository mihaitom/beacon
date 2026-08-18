<template>
  <div
    class="mobile-song-row d-flex align-center"
    :class="{ 'mobile-song-row--current': isCurrentSong }"
    @click="$emit('play')"
  >
    <cover-art :cover-art-id="song.coverArtId" :size="44" class="mr-3 flex-shrink-0" />
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-2 text-truncate" :class="{ 'text-primary': isCurrentSong }">
        {{ song.title }}
      </div>
      <div class="text-caption text-medium-emphasis text-truncate">{{ song.artist }}</div>
    </div>
    <v-btn
      v-if="authStore.capabilities.favorites"
      :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'"
      :color="song.starred ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      size="small"
      @click.stop="$emit('toggle-star')"
    />
    <v-btn
      icon="mdi-dots-vertical"
      variant="text"
      density="comfortable"
      size="small"
      @click.stop="$emit('open-actions')"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'MobileSongRow',
  components: { CoverArt },
  props: {
    song: {
      type: Object,
      required: true,
    },
  },
  emits: ['play', 'toggle-star', 'open-actions'],
  computed: {
    authStore() {
      return useAuthStore()
    },
    isCurrentSong() {
      return usePlaybackStore().currentSong?.id === this.song.id
    },
  },
}
</script>

<style scoped>
.mobile-song-row {
  min-height: 60px;
  padding: 4px;
  border-radius: 8px;
}

.mobile-song-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.min-width-0 {
  min-width: 0;
}
</style>
