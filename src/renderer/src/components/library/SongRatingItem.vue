<template>
  <!-- A row of stars in a song's menu, in its Library section: a rating is
   - one more thing that is still true tomorrow. Picking a star closes the
   - menu like any other entry. Where the server has no 1-5 scale
   - (Jellyfin) the row is left out entirely. -->
  <div v-if="authStore.capabilities.personalRating" class="song-rating-item">
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
  </div>
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

<style scoped>
/* Lined up with the menu items' own icons, see ContextMenuSection.vue. */
.song-rating-item {
  padding: 2px 12px 6px;
}
</style>
