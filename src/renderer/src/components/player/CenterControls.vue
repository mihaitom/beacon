<template>
  <div class="center-controls d-flex align-center" style="gap: 4px">
    <v-btn
      icon="mdi-shuffle"
      :color="playbackStore.shuffle ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      @click="playbackStore.toggleShuffle()"
    />
    <v-btn
      icon="mdi-skip-previous"
      variant="text"
      density="comfortable"
      :disabled="!hasPlayable"
      @click="playbackStore.playPrevious()"
    />
    <v-btn
      class="play-btn mx-1"
      :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
      variant="flat"
      color="primary"
      size="large"
      density="comfortable"
      :disabled="!hasPlayable"
      @click="playbackStore.togglePlay()"
    />
    <v-btn
      icon="mdi-skip-next"
      variant="text"
      density="comfortable"
      :disabled="!hasPlayable || !playbackStore.hasNext"
      @click="playbackStore.playNext()"
    />
    <v-btn
      :icon="repeatIcon"
      :color="playbackStore.repeatMode !== 'off' ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      @click="playbackStore.cycleRepeatMode()"
    />
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'

export default {
  name: 'CenterControls',
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    hasPlayable() {
      return this.playbackStore.currentSong != null || this.playbackStore.radioStation != null
    },
    repeatIcon() {
      return this.playbackStore.repeatMode === 'one' ? 'mdi-repeat-once' : 'mdi-repeat'
    },
  },
}
</script>

<style scoped>
/* Filled, inverted-color circle — reads as "the" button at a glance next
 * to the flanking transport buttons' plain outlined icons. */
.play-btn :deep(.v-icon) {
  color: rgb(var(--v-theme-background));
}
</style>
