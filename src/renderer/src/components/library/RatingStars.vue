<template>
  <!-- The stars in a list row's own cell, rated in place - the album and
   - artist lists' counterpart of SongRow.vue's rating column. The row
   - decides when they show; this only draws them and saves a pick. -->
  <v-rating
    :model-value="item.rating"
    length="5"
    size="small"
    density="compact"
    active-color="primary"
    hover
    clearable
    :aria-label="$t('library.rating')"
    class="rating-stars"
    @click.stop
    @update:model-value="rate"
  />
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'
import type { Album, Artist } from '@/types/library'

export default {
  name: 'RatingStars',
  props: {
    item: { type: Object as PropType<Album | Artist>, required: true },
  },
  methods: {
    rate(value: number | string): void {
      void useLibraryStore().rate(this.item, Number(value))
    },
  },
}
</script>

<style scoped>
/* The same size as the song table's stars (SongRow.vue). */
.rating-stars :deep(.v-icon) {
  font-size: 16px;
}
</style>
