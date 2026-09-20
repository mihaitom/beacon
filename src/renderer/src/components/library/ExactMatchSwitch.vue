<template>
  <v-switch
    :model-value="libraryStore.searchExact"
    class="exact-match-switch"
    color="primary"
    density="compact"
    hide-details
    :label="$t('search.exactMatch')"
    @update:model-value="setExact"
  />
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'

/** The exact-search switch shown beside a library filter field. Bound to the
 * one app-wide preference (stores/library.ts's searchExact), so every field
 * that offers the switch follows whichever copy is toggled and the choice is
 * remembered. Playlists and Radio never show it - both are always exact. */
export default {
  name: 'ExactMatchSwitch',
  emits: ['change'],
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
  methods: {
    setExact(value: boolean | null): void {
      const exact = value === true
      this.libraryStore.setSearchExact(exact)
      // A filter field's list follows the preference reactively; the search
      // results page has to ask for its results again, which is this.
      this.$emit('change', exact)
    },
  },
}
</script>

<style scoped>
/* Vuetify gives a switch a row of its own with margins; pulled in so it sits
 * beside the field it belongs to rather than drifting away from it. Its
 * vertical alignment against the field is set by .library-filter in base.css,
 * which only the library rows need. */
.exact-match-switch {
  flex: 0 0 auto;
  margin: 0;
}
</style>
