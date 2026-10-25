<template>
  <div class="library-list-header" :style="gridStyle">
    <div class="library-list-header__row">
      <div
        v-for="column in columns"
        :key="column.key"
        class="library-list-header__cell"
        :class="{
          'library-list-header__cell--end': column.align === 'end',
          'library-list-header__cell--active': isActive(column),
          'library-list-header__cell--drop-narrow': column.dropNarrow,
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
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export interface ListHeaderColumn {
  key: string
  label: string
  align?: 'start' | 'end'
  /** The orders this column stands for - the album column for both name
   * and artist, since a row shows the artist under the name. */
  sortKeys?: string[]
  /** Given up under 640px, along with the rows' own copy of it. */
  dropNarrow?: boolean
}

/** The column labels over the album and artist lists in their list form,
 * the way the song table has them. Labels only: the order is changed in
 * the sort select, and the column it sorts by is lit with its direction.
 *
 * The columns have to line up with the rows', which lay themselves out in
 * AlbumCard.vue/ArtistCard.vue - the caller hands over the same
 * grid-template-columns those use, and the narrow one their container
 * query switches to. */
export default {
  name: 'LibraryListHeader',
  props: {
    columns: { type: Array as PropType<ListHeaderColumn[]>, required: true },
    template: { type: String, required: true },
    narrowTemplate: { type: String, default: null },
    sortKey: { type: String, default: null },
    direction: { type: String as PropType<'asc' | 'desc'>, default: 'asc' },
  },
  computed: {
    gridStyle(): Record<string, string> {
      return {
        '--list-columns': this.template,
        '--list-columns-narrow': this.narrowTemplate ?? this.template,
      }
    },
  },
  methods: {
    isActive(column: ListHeaderColumn): boolean {
      return Boolean(this.sortKey && column.sortKeys?.includes(this.sortKey))
    },
  },
}
</script>

<style scoped>
/* Pinned under the page's sticky filter row, like the song table's header -
 * the caller sets --sticky-header-offset to that row's height. */
.library-list-header {
  container-type: inline-size;
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
  grid-template-columns: var(--list-columns);
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

@container (max-width: 640px) {
  .library-list-header__row {
    grid-template-columns: var(--list-columns-narrow);
  }

  .library-list-header__cell--drop-narrow {
    display: none;
  }
}
</style>
