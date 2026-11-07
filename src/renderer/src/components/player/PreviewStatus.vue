<template>
  <!-- Says that what plays is a preview rather than the queue, and offers
   - to play the album or playlist from the song it has reached - one the
   - library holds. -->
  <div v-if="preview" class="preview-status">
    <span class="eyebrow-label">{{
      $t('player.preview', { index: preview.index + 1, count: preview.picks.length })
    }}</span>
    <v-btn
      v-if="preview.whole && playbackStore.currentSongInLibrary"
      size="x-small"
      variant="tonal"
      rounded="pill"
      color="primary"
      @click.stop="playbackStore.playFromPreview()"
    >
      {{ $t('player.playFromHere') }}
    </v-btn>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'

export default {
  name: 'PreviewStatus',
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    preview() {
      return this.playbackStore.preview
    },
  },
}
</script>

<style scoped>
.preview-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
</style>
