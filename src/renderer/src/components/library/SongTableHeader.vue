<template>
  <div class="song-table-header">
    <div class="song-index" />
    <div v-if="showCover" class="song-cover-spacer" />
    <div class="song-title min-width-0">
      <button type="button" class="sort-header" @click="$emit('sort', 'title')">
        {{ $t('library.title') }}
        <v-icon v-if="sortKey === 'title'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div v-if="showAlbum" class="song-album">
      <button type="button" class="sort-header" @click="$emit('sort', 'album')">
        {{ $t('library.album') }}
        <v-icon v-if="sortKey === 'album'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div v-if="showGenre" class="song-genre">
      <button type="button" class="sort-header" @click="$emit('sort', 'genre')">
        {{ $t('library.genre') }}
        <v-icon v-if="sortKey === 'genre'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div v-if="showYear" class="song-year">
      <button type="button" class="sort-header" @click="$emit('sort', 'year')">
        {{ $t('library.year') }}
        <v-icon v-if="sortKey === 'year'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div v-if="showPlayCount" class="song-playcount">
      <button type="button" class="sort-header" @click="$emit('sort', 'playCount')">
        {{ $t('library.plays') }}
        <v-icon v-if="sortKey === 'playCount'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div v-if="showFormat" class="song-format">
      <button type="button" class="sort-header" @click="$emit('sort', 'format')">
        {{ $t('library.format') }}
        <v-icon v-if="sortKey === 'format'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div class="song-duration">
      <button type="button" class="sort-header" @click="$emit('sort', 'duration')">
        {{ $t('library.duration') }}
        <v-icon v-if="sortKey === 'duration'" :icon="arrowIcon" size="12" />
      </button>
    </div>
    <div class="song-actions">
      <button type="button" class="sort-header" @click="$emit('sort', 'rating')">
        {{ $t('library.rating') }}
        <v-icon v-if="sortKey === 'rating'" :icon="arrowIcon" size="12" />
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export default {
  name: 'SongTableHeader',
  props: {
    showCover: { type: Boolean, default: false },
    showAlbum: { type: Boolean, default: false },
    showGenre: { type: Boolean, default: false },
    showYear: { type: Boolean, default: false },
    showPlayCount: { type: Boolean, default: false },
    showFormat: { type: Boolean, default: false },
    sortKey: { type: String as PropType<string | null>, default: null },
    sortDirection: { type: String, default: 'asc' },
  },
  emits: ['sort'],
  computed: {
    arrowIcon() {
      return this.sortDirection === 'desc' ? 'mdi-arrow-down' : 'mdi-arrow-up'
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
}

/* The gap carries the sort arrow, which is why no icon in here needs a
 * margin of its own. */
.sort-header {
  display: inline-flex;
  align-items: center;
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

/* Widths/flex-grow here must mirror SongRow.vue's exactly, column for
 * column, or the header labels drift out of alignment with the rows. */
.song-index {
  flex: 0 0 44px;
}

.song-cover-spacer {
  flex: 0 0 40px;
}

.song-title {
  flex: 3 1 160px;
}

.song-album {
  flex: 2 1 120px;
  min-width: 0;
}

.song-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.song-year {
  flex: 0 0 44px;
}

.song-year .sort-header,
.song-playcount .sort-header,
.song-format .sort-header,
.song-duration .sort-header,
.song-actions .sort-header {
  justify-content: flex-end;
  width: 100%;
}

.song-playcount {
  flex: 0 0 44px;
}

.song-format {
  flex: 0 0 120px;
}

.song-duration {
  flex: 0 0 44px;
}

/* Matches the rating + star + menu buttons' combined width in SongRow.
 * The heart/menu buttons have no header label of their own, so the
 * "Rating" label is padded off the right edge by roughly their combined
 * width — lining it up over the star icons rather than the far edge. */
.song-actions {
  flex: 0 0 200px;
  padding-right: 76px;
}

.min-width-0 {
  min-width: 0;
}
</style>
