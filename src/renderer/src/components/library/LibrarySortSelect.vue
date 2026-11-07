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
    <!-- Every order's name stacked in one cell, only the picked one
       - visible: the pill is as wide as its longest, so it keeps its width
       - whichever order is on, and no name is cut off. -->
    <template #selection="{ item }">
      <span class="library-sort__label">
        <span
          v-for="option in items"
          :key="option.value"
          class="library-sort__name"
          :class="{ 'library-sort__name--shown': option.value === item.value }"
          :aria-hidden="option.value !== item.value"
          >{{ option.title }}</span
        >
      </span>
    </template>
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
/* As wide as its longest order (see the selection slot), giving only in a
 * window too narrow for the controls beside it - those keep their width
 * (see .library-controls). */
.library-sort {
  flex: 0 1 auto;
  min-width: 160px;
}

.library-sort__label {
  display: inline-grid;
  min-width: 0;
}

.library-sort__name {
  grid-area: 1 / 1;
  visibility: hidden;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-sort__name--shown {
  visibility: visible;
}
</style>
