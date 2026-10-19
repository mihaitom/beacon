<template>
  <!-- An "Aa" toggle in a search field's end, the way an editor's find box
     - offers case matching - it belongs to the search, not beside it as a
     - setting. Its name is in the tooltip. -->
  <v-btn
    icon="mdi-format-letter-case"
    size="small"
    variant="text"
    class="exact-match-toggle"
    :class="{ 'exact-match-toggle--on': libraryStore.searchExact }"
    :title="$t('search.exactMatch')"
    :aria-label="$t('search.exactMatch')"
    :aria-pressed="libraryStore.searchExact"
    @click.stop="libraryStore.setSearchExact(!libraryStore.searchExact)"
  />
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'

/** The exact-search toggle, for a search field's #append-inner slot - the
 * top bar's and every library filter field's. Bound to the one app-wide
 * preference (stores/library.ts's searchExact), so every copy follows
 * whichever is toggled and the choice is remembered. Playlists and Radio
 * never show it - both are always exact. */
export default {
  name: 'ExactMatchSwitch',
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
}
</script>

<style scoped>
/* The same pill and amber as a selected .beacon-view-toggle segment, so a
 * filter row's two toggles read alike. Pulled towards the field's edge:
 * Vuetify's end padding left it floating in the middle of the pill's
 * rounding. */
.exact-match-toggle.v-btn {
  width: 32px;
  height: 28px;
  margin-right: -6px;
  border-radius: 9999px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.exact-match-toggle--on.v-btn {
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.14);
}
</style>
