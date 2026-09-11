<template>
  <div
    class="song-table-header"
    @contextmenu.prevent="openColumnMenu"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div
      v-for="column in columns"
      :key="column.key"
      :data-column="column.key"
      class="song-col"
      :class="{
        'song-col--end': column.align === 'end',
        'song-col--select': column.cell === 'index',
      }"
      :style="{ flex: column.flex, minWidth: column.minWidth }"
    >
      <!-- The index column carries no heading of its own, so in a list that
         - can be selected it carries the select-all instead - sitting
         - directly over the row checkboxes it switches (SongRow.vue draws
         - them in the same cell). Escape and a second Ctrl+A already
         - cleared a selection, but only the keyboard ever said so. -->
      <v-checkbox-btn
        v-if="column.cell === 'index' && showSelectAll"
        :model-value="allSelected"
        :indeterminate="someSelected"
        density="compact"
        class="select-all-checkbox"
        :title="selectAllLabel"
        :aria-label="selectAllLabel"
        @click.stop="$emit('toggle-select-all')"
      />

      <button
        v-else-if="column.sortValue"
        type="button"
        class="sort-header"
        :title="$t(column.labelKey)"
        @click="$emit('sort', column.key)"
      >
        <!-- Every column is wide enough for its own heading in all five
           - languages (SongTableHeader.layout.browser.test.ts measures it),
           - so this should never actually clip - but a heading that does,
           - through a font that falls back or a language added later, has to
           - end in an ellipsis rather than in the next column. The title
           - attribute above is what it can still be read with. -->
        <span class="sort-header__label">{{ $t(column.labelKey) }}</span>
        <v-icon v-if="sortKey === column.key" :icon="arrowIcon" size="12" />
      </button>
    </div>

    <!-- The one control in the header row that isn't a column heading, so
       - it sits outside the loop: right-click anywhere on the row opens the
       - same menu, and this button is what says so to anyone who wouldn't
       - think to try. -->
    <button
      v-if="configurable"
      type="button"
      class="column-menu-button"
      :title="$t('library.columns')"
      @click="openColumnMenu"
    >
      <v-icon icon="mdi-view-column-outline" size="16" />
    </button>

    <song-column-menu v-if="configurable" ref="columnMenu" />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import SongColumnMenu from './SongColumnMenu.vue'
import type { SongColumn } from '@/services/library/songColumns'

export default {
  name: 'SongTableHeader',
  components: { SongColumnMenu },
  props: {
    /** Already resolved by SongTable.vue - this draws what it is given, in
     * the order it is given, and SongRow.vue draws the same array. */
    columns: { type: Array as PropType<SongColumn[]>, required: true },
    sortKey: { type: String as PropType<string | null>, default: null },
    sortDirection: { type: String, default: 'asc' },
    /** False for a table whose columns the view fixed itself (Home's
     * top-songs chart) - there is nothing for the menu to change there. */
    configurable: { type: Boolean, default: true },
    /** How much of the list below is currently selected. Both counts come
     * from SongTable.vue, which owns the selection; together they decide
     * whether the select-all reads as off, part-way (indeterminate) or on. */
    selectedCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 },
  },
  emits: ['sort', 'toggle-select-all'],
  data() {
    return { isHovered: false }
  },
  computed: {
    arrowIcon() {
      return this.sortDirection === 'desc' ? 'mdi-arrow-down' : 'mdi-arrow-up'
    },
    // Same rule as a row's own checkbox (SongRow.vue): shown while the
    // pointer is on it, and shown to everyone the moment a selection is
    // running - which is when the way back out of one is what is wanted.
    showSelectAll(): boolean {
      return this.totalCount > 0 && (this.selectedCount > 0 || this.isHovered)
    },
    allSelected(): boolean {
      return this.totalCount > 0 && this.selectedCount >= this.totalCount
    },
    someSelected(): boolean {
      return this.selectedCount > 0 && !this.allSelected
    },
    selectAllLabel(): string {
      return this.allSelected ? this.$t('library.selectNone') : this.$t('library.selectAll')
    },
  },
  methods: {
    openColumnMenu(event: MouseEvent): void {
      if (!this.configurable) return
      ;(this.$refs.columnMenu as { open: (event: MouseEvent) => void } | undefined)?.open(event)
    },
  },
}
</script>

<style scoped>
/* The app's small-label voice - upper case, tracked, heavier - the same
 * shape as .eyebrow-label in base.css, so this reads as a label *about*
 * the list rather than as one more, slightly greyer, row of it. It used to
 * be plain sentence case at 0.75rem, which is the size and casing of the
 * data underneath: the only thing separating the two was opacity.
 *
 * White rather than the eyebrow's amber, though. Amber is the signal
 * colour, and eight amber column headings would spend it on a row nobody
 * needs to look at twice - it goes to the one heading that is actually
 * saying something instead (see .sort-header below). */
.song-table-header {
  display: flex;
  align-items: center;
  position: relative;
  /* Mirrors SongRow.vue's own horizontal padding, so a column heading sits
   * over the column it names. */
  padding: 0 8px 6px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid var(--beacon-hairline);
  gap: 12px;
  /* Room for the select-all below (20px) plus this row's own bottom
   * padding: the checkbox is taller than a line of 11px label, and without
   * the space held open the whole table would drop a few pixels the moment
   * the pointer touched the heading row. */
  min-height: 26px;
}

/* Smaller than the row's own checkbox (28px at density compact): the
 * heading row is a third the height of a song row, and a checkbox at row
 * size would be by far the tallest thing in it. The negative margin is
 * SongRow.vue's, for the same reason - the hit area is wider than the 44px
 * index column - and it is also what puts this checkbox exactly over the
 * ones underneath. */
.select-all-checkbox {
  --v-selection-control-size: 20px;
  margin: 0 -8px;
}

:deep(.select-all-checkbox .v-icon) {
  font-size: 16px;
}

/* Column widths come from services/library/songColumns.ts (bound inline
 * above), not from a class per column: SongRow.vue binds the same value
 * from the same array, which is what keeps a heading over its own column
 * without the two files having to agree by hand - the minimum included. */
.song-col {
  overflow: hidden;
}

/* The one cell holding something wider than itself - see the negative
 * margin on .select-all-checkbox below, which the clipping above would
 * otherwise take a bite out of. The rows' own cells don't clip at all
 * (SongRow.vue), which is why their checkbox never needed this. */
.song-col--select {
  overflow: visible;
}

.song-col--end .sort-header {
  justify-content: flex-end;
  width: 100%;
}

/* The gap carries the sort arrow, which is why no icon in here needs a
 * margin of its own. */
.sort-header {
  display: inline-flex;
  align-items: center;
  /* Or the button, sized to its own content, simply runs past the cell and
   * the ellipsis on the label inside it never comes into play. */
  max-width: 100%;
  gap: 4px;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  /* Both are inherited by everything else on the page, but not by a form
   * control: the UA stylesheet resets them on <button> (to `none` and
   * `normal`), and `font: inherit` does not cover either - neither is part
   * of the font shorthand. Without these two lines every heading is a
   * button that quietly ignores the casing and tracking set on the row
   * above it, which is exactly how it rendered on the first attempt. */
  text-transform: inherit;
  letter-spacing: inherit;
}

/* The label, not the button: the sort arrow beside it must keep its full
 * 12px rather than being the thing that gets cut off. */
.sort-header__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sort-header:hover {
  color: rgba(255, 255, 255, 0.85);
}

/* The column the list is currently sorted by, lit in the app's amber. The
 * arrow alone said this before, at 12px and in the same grey as the seven
 * headings that mean nothing at that moment.
 *
 * Keyed off the arrow's own presence rather than a second flag threaded
 * through the template: the heading that renders an icon is by definition
 * the active one, so the two cannot fall out of step. A browser without
 * :has() simply keeps the grey heading and its arrow, which is what this
 * looked like before. */
.sort-header:has(.v-icon) {
  color: rgb(var(--v-theme-primary));
}

/* Sits over the actions column's right edge rather than taking a column of
 * its own: every pixel it claimed would come off the rows' own widths, and
 * the space above the "..." buttons is empty in every row of the table. */
.column-menu-button {
  position: absolute;
  right: 8px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
}

.column-menu-button:hover {
  color: rgba(255, 255, 255, 0.85);
}
</style>
