<template>
  <!-- A song's stars in its menu's Library section: a rating is one more
   - thing that is still true tomorrow. Shaped like every other entry, an
   - icon and then the entry itself, with the stars standing where a label
   - would; the icon is not a star, or the row would start with a sixth one.
   - Picking a star closes the menu like any other entry. Where the server
   - has no 1-5 scale (Jellyfin) the row is left out entirely. -->
  <v-list-item v-if="authStore.capabilities.personalRating" class="song-rating-item">
    <template #prepend><v-icon icon="mdi-thumbs-up-down-outline" size="small" /></template>
    <v-rating
      :model-value="song.rating"
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
import type { Song } from '@/types/library'

export default {
  name: 'SongRatingItem',
  props: {
    song: { type: Object as PropType<Song>, required: true },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    rate(value: number | string): void {
      void useLibraryStore().rate(this.song, Number(value))
    },
  },
}
</script>
