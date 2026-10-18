<template>
  <router-link :to="`/m/artists/${artist.id}`" class="mobile-artist-row mobile-row">
    <!-- A row that stands for a collection opens it, like MobileAlbumRow.vue.
     - No play button: an artist has no one order to play in, and the page
     - it opens has the artist radio for that. -->
    <cover-art
      :cover-art-id="artist.coverArtId"
      :image-url="artist.imageUrl"
      :size="MOBILE_ROW_ART_SIZE"
      fallback-icon="mdi-account-music"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium">{{ artist.name }}</div>
      <div class="text-body-small text-medium-emphasis">
        {{ $n(artist.albumCount) }}
        {{ artist.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }}
      </div>
    </div>
  </router-link>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import type { Artist } from '@/types/library'

export default {
  name: 'MobileArtistRow',
  components: { CoverArt },
  props: {
    artist: {
      type: Object as () => Artist,
      required: true,
    },
  },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
}
</script>

<style scoped>
.mobile-artist-row {
  text-decoration: none;
  color: inherit;
}
</style>
