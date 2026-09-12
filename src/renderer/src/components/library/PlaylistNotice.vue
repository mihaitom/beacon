<template>
  <!-- What just happened to this playlist, said where the playlist is.
     - Shaped like ConnectErrorBanner.vue's own row: the sentence, then the
     - one thing you might want to do about it. -->
  <v-alert
    :type="notice.level"
    variant="tonal"
    density="compact"
    closable
    class="view-notice"
    @click:close="$emit('dismiss')"
  >
    <div class="playlist-notice">
      <div class="playlist-notice__text">
        {{ notice.text }}
        <div v-if="notice.detail" class="playlist-notice__detail text-body-small">
          {{ notice.detail }}
        </div>
      </div>
      <v-btn v-if="notice.undo" size="small" variant="text" @click="$emit('undo')">
        {{ $t('common.undo') }}
      </v-btn>
    </div>
  </v-alert>
</template>

<script lang="ts">
import type { PlaylistNotice } from '@/services/library/playlistRemoval'

export default {
  name: 'PlaylistNotice',
  props: {
    notice: {
      type: Object as () => PlaylistNotice,
      required: true,
    },
  },
  emits: ['undo', 'dismiss'],
}
</script>

<style scoped>
.playlist-notice {
  display: flex;
  align-items: center;
  gap: 12px;
}

.playlist-notice__text {
  flex: 1 1 auto;
  min-width: 0;
}

/* The server's own words, when there are any - a second line under the
 * sentence rather than beside it, so a long one doesn't push the button
 * off the end of a phone-width banner. */
.playlist-notice__detail {
  opacity: 0.75;
}
</style>
