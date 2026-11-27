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
      <div v-if="detail" class="mobile-split-line text-body-small text-medium-emphasis">
        <span>{{ album.artist }}</span>
        <span>{{ detail }}</span>
      </div>
      <div v-else class="text-body-small text-medium-emphasis">{{ meta }}</div>
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
import type { PropType } from 'vue'
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
    /** What the list is sorted by, after the second line's own text (see
     * libraryBrowse.ts's sortDetail()). */
    detail: { type: String as PropType<string | null>, default: null },
  },
  emits: ['play'],
  computed: {
    /** Artist first, since that is what tells two same-named albums apart;
     * the year only when the server actually reports one. Sorted by
     * something, the row shows that at its end instead of the year. */
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
