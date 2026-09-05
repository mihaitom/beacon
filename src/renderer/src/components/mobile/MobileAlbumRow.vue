<template>
  <div class="mobile-album-row mobile-row" @click="$emit('play')">
    <!-- Tapping the row plays the album, the same "tap is play" MobileSongRow
     - uses — no hover state exists on touch to reveal anything else, and the
     - desktop's album *grid* (AlbumCard.vue) has no mobile-sized design of
     - its own. The explicit play button stays for the same reason
     - MobilePlaylistRow.vue keeps one: it says the row is playable rather
     - than leaving that to be discovered. -->
    <cover-art
      :cover-art-id="album.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      fallback-icon="mdi-album"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium text-truncate">{{ album.name }}</div>
      <div class="text-body-small text-medium-emphasis text-truncate">{{ meta }}</div>
    </div>
    <v-btn
      icon="mdi-play-circle"
      variant="text"
      size="small"
      color="primary"
      :title="$t('library.play')"
      @click.stop="$emit('play')"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import type { Album } from '@/types/library'

export default {
  name: 'MobileAlbumRow',
  components: { CoverArt },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
  props: {
    album: {
      type: Object as () => Album,
      required: true,
    },
  },
  emits: ['play'],
  computed: {
    /** Artist first, since that is what tells two same-named albums apart;
     * the year only when the server actually reports one. */
    meta(): string {
      return [this.album.artist, this.album.year].filter(Boolean).join(' · ')
    },
  },
}
</script>

<style scoped>
.mobile-album-row {
  cursor: pointer;
}
</style>
