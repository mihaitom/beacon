<template>
  <router-link :to="`/m/albums/${album.id}`" class="mobile-album-row mobile-row">
    <!-- Tapping the row opens the album, the same split MobilePlaylistRow.vue
     - makes: a row that stands for a collection leads to it, and the button
     - is what plays it. MobileSongRow's "tap is play" is for rows that are a
     - single track, where there is nothing to open. -->
    <cover-art
      :cover-art-id="album.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      fallback-icon="mdi-album"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium">{{ album.name }}</div>
      <div class="text-body-small text-medium-emphasis">{{ meta }}</div>
    </div>
    <v-btn
      icon="mdi-play-circle"
      variant="text"
      size="small"
      color="primary"
      :title="$t('library.play')"
      @click.prevent.stop="$emit('play')"
    />
  </router-link>
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
  text-decoration: none;
  color: inherit;
}
</style>
