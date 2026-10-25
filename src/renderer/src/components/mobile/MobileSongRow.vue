<template>
  <div
    class="mobile-song-row mobile-row"
    :class="{ 'mobile-song-row--current': isCurrentSong }"
    @click="$emit('play')"
  >
    <cover-art
      :cover-art-id="song.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium" :class="{ 'text-primary': isCurrentSong }">
        {{ song.title }}
      </div>
      <artist-credit
        :credit="song.artist"
        :artist-id="song.artistId"
        :linked="false"
        class="text-body-small text-medium-emphasis"
      />
    </div>
    <!-- The favourite toggle is in the song's actions behind this button
     - rather than a second button on every row. -->
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
import ArtistCredit from '@/components/library/ArtistCredit.vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import { usePlaybackStore } from '@/stores/playback'

export default {
  name: 'MobileSongRow',
  components: { ArtistCredit, CoverArt },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
  props: {
    song: {
      type: Object,
      required: true,
    },
  },
  emits: ['play', 'open-actions'],
  computed: {
    isCurrentSong() {
      return usePlaybackStore().currentSong?.id === this.song.id
    },
  },
}
</script>

<style scoped>
.mobile-song-row {
}

.mobile-song-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}
</style>
