<template>
  <!-- The stars in a song's or album's menu, in its Library section: a
   - rating is one more thing that is still true tomorrow. Shaped like every other entry, an
   - icon and then the entry itself, with the stars standing where a label
   - would; the icon is not a star, or the row would start with a sixth one.
   - Picking a star closes the menu like any other entry. Where the server
   - has no 1-5 scale (Jellyfin) the row is left out entirely. -->
  <v-list-item v-if="authStore.capabilities.personalRating" class="rating-item">
    <template #prepend><v-icon icon="mdi-thumbs-up-down-outline" size="small" /></template>
    <v-rating
      :model-value="item.rating"
      length="5"
      size="small"
      density="compact"
      active-color="primary"
      hover
      clearable
      :aria-label="$t('library.rating')"
      @update:model-value="rate"
    />
  </v-list-item>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import type { Album, Artist, Song } from '@/types/library'

export default {
  name: 'RatingItem',
  props: {
    item: { type: Object as PropType<Song | Album | Artist>, required: true },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    rate(value: number | string): void {
      void useLibraryStore().rate(this.item, Number(value))
    },
  },
}
</script>
