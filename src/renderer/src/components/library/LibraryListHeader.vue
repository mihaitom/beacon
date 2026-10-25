<template>
  <div class="library-list-header" @contextmenu.prevent="openColumnMenu">
    <div class="library-list-header__row" :style="{ gridTemplateColumns: template }">
      <div
        v-for="column in columns"
        :key="column.key"
        class="library-list-header__cell"
        :class="{
          'library-list-header__cell--end': column.align === 'end',
          'library-list-header__cell--active': isActive(column),
        }"
      >
        <span class="library-list-header__label">{{ column.label }}</span>
        <v-icon
          v-if="isActive(column)"
          :icon="direction === 'desc' ? 'mdi-arrow-down' : 'mdi-arrow-up'"
          size="12"
        />
      </div>
    </div>
    <!-- The song table's column button (SongTableHeader.vue), over the
       - menu buttons, whose column has no heading of its own. -->
    <button
      v-if="columnChoices"
      type="button"
      class="column-menu-button"
      :title="$t('library.columns')"
      @click="openColumnMenu"
    >
      <v-icon icon="mdi-view-column-outline" size="16" />
    </button>
    <library-column-menu
      v-if="columnChoices"
      ref="columnMenu"
      :choices="columnChoices"
      @toggle="$emit('toggle-column', $event)"
      @reset="$emit('reset-columns')"
    />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import LibraryColumnMenu, { type ColumnChoice } from './LibraryColumnMenu.vue'

export interface ListHeaderColumn {
  key: string
  label: string
  align?: 'start' | 'end'
  /** The orders this column stands for - the album column for both name
   * and artist, since a row shows the artist under the name. */
  sortKeys?: readonly string[]
}

/** The column labels over the album and artist lists in their list form,
 * the way the song table has them. Labels only: the order is changed in
 * the sort select, and the column it sorts by is lit with its direction.
 *
 * The columns have to line up with the rows', so the caller hands over the
 * same grid-template-columns AlbumCard.vue/ArtistCard.vue draw their rows
 * with (see services/library/listColumns.ts). */
export default {
  name: 'LibraryListHeader',
  components: { LibraryColumnMenu },
  props: {
    columns: { type: Array as PropType<ListHeaderColumn[]>, required: true },
    template: { type: String, required: true },
    sortKey: { type: String, default: null },
    direction: { type: String as PropType<'asc' | 'desc'>, default: 'asc' },
    /** The optional columns to offer in the picker; none, no picker. */
    columnChoices: { type: Array as PropType<ColumnChoice[] | null>, default: null },
  },
  emits: ['toggle-column', 'reset-columns'],
  methods: {
    isActive(column: ListHeaderColumn): boolean {
      return Boolean(this.sortKey && column.sortKeys?.includes(this.sortKey))
    },
    openColumnMenu(event: MouseEvent): void {
      ;(this.$refs.columnMenu as { open: (event: MouseEvent) => void } | undefined)?.open(event)
    },
  },
}
</script>

<style scoped>
/* Pinned under the page's sticky filter row, like the song table's header -
 * the caller sets --sticky-header-offset to that row's height. */
.library-list-header {
  position: sticky;
  top: calc(var(--beacon-sticky-top, var(--v-layout-top, 0px)) + var(--sticky-header-offset, 0px));
  z-index: 2;
  background: rgb(var(--v-theme-background));
  /* See SongTable.vue's sticky header: its own layer, or Chromium wobbles it. */
  transform: translateZ(0);
}

/* The type of SongTableHeader.vue's headings, and the rows' padding and gap. */
.library-list-header__row {
  display: grid;
  align-items: center;
  gap: 16px;
  padding: 0 8px 6px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.42);
  border-bottom: 1px solid var(--beacon-hairline);
  min-height: 26px;
}

.library-list-header__cell {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.library-list-header__cell--end {
  justify-content: flex-end;
}

.library-list-header__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-list-header__cell--active {
  color: rgb(var(--v-theme-primary));
}

/* Over the rows' menu buttons, as in SongTableHeader.vue. */
.column-menu-button {
  position: absolute;
  right: 14px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  color: rgba(var(--v-theme-on-surface), 0.42);
  cursor: pointer;
}

.column-menu-button:hover {
  color: rgba(var(--v-theme-on-surface), 0.85);
}
</style>
