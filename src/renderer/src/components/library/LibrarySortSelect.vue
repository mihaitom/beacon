<template>
  <v-select
    :model-value="modelValue"
    :items="items"
    :aria-label="$t('library.sortBy')"
    prepend-inner-icon="mdi-sort"
    variant="solo-filled"
    density="compact"
    rounded="pill"
    flat
    hide-details
    class="library-sort"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template v-if="direction" #append-inner>
      <v-btn
        :icon="direction === 'desc' ? 'mdi-arrow-down' : 'mdi-arrow-up'"
        :title="$t(`library.songSort.${direction}`)"
        :aria-label="$t(`library.songSort.${direction}`)"
        variant="text"
        size="x-small"
        @click.stop="$emit('toggle-direction')"
        @mousedown.stop
      />
    </template>
  </v-select>
</template>

<script lang="ts">
import type { PropType } from 'vue'

/** The sort pill of a library list: which order, and an arrow in its end
 * that turns it round. Null for `direction` leaves the arrow out, for an
 * order that has none (a search's best matches). */
export default {
  name: 'LibrarySortSelect',
  props: {
    modelValue: { type: String, required: true },
    items: { type: Array as PropType<{ title: string; value: string }[]>, required: true },
    direction: { type: String as PropType<'asc' | 'desc' | null>, default: null },
  },
  emits: ['update:modelValue', 'toggle-direction'],
}
</script>

<style scoped>
.library-sort {
  flex: 0 0 220px;
}
</style>
