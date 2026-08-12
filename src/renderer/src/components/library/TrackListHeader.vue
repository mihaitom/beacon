<template>
  <div class="track-list-header d-flex align-center px-2 pb-1">
    <div class="track-index" />
    <div v-if="showCover" class="track-cover-spacer" />
    <div class="track-title min-width-0">
      <button type="button" class="sort-header" @click="$emit('sort', 'title')">
        {{ $t('library.title') }}
        <v-icon v-if="sortKey === 'title'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showAlbum" class="track-album">
      <button type="button" class="sort-header" @click="$emit('sort', 'album')">
        {{ $t('library.album') }}
        <v-icon v-if="sortKey === 'album'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showGenre" class="track-genre">
      <button type="button" class="sort-header" @click="$emit('sort', 'genre')">
        {{ $t('library.genre') }}
        <v-icon v-if="sortKey === 'genre'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showYear" class="track-year">
      <button type="button" class="sort-header" @click="$emit('sort', 'year')">
        {{ $t('library.year') }}
        <v-icon v-if="sortKey === 'year'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showPlayCount" class="track-playcount">
      <button type="button" class="sort-header" @click="$emit('sort', 'playCount')">
        {{ $t('library.plays') }}
        <v-icon v-if="sortKey === 'playCount'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showFormat" class="track-format">
      <button type="button" class="sort-header" @click="$emit('sort', 'format')">
        {{ $t('library.format') }}
        <v-icon v-if="sortKey === 'format'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div class="track-duration">
      <button type="button" class="sort-header" @click="$emit('sort', 'duration')">
        {{ $t('library.duration') }}
        <v-icon v-if="sortKey === 'duration'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div class="track-actions">
      <button type="button" class="sort-header" @click="$emit('sort', 'rating')">
        {{ $t('library.rating') }}
        <v-icon v-if="sortKey === 'rating'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export default {
  name: 'TrackListHeader',
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
.track-list-header {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
  border-bottom: 1px solid var(--beacon-hairline);
  gap: 12px;
}

.sort-header {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.sort-header:hover {
  color: rgba(255, 255, 255, 0.85);
}

/* Widths/flex-grow here must mirror TrackRow.vue's exactly, column for
 * column, or the header labels drift out of alignment with the rows. */
.track-index {
  flex: 0 0 28px;
}

.track-cover-spacer {
  flex: 0 0 40px;
}

.track-title {
  flex: 3 1 160px;
}

.track-album {
  flex: 2 1 120px;
  min-width: 0;
}

.track-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.track-year {
  flex: 0 0 44px;
}

.track-year .sort-header,
.track-playcount .sort-header,
.track-format .sort-header,
.track-duration .sort-header,
.track-actions .sort-header {
  justify-content: flex-end;
  width: 100%;
}

.track-playcount {
  flex: 0 0 44px;
}

.track-format {
  flex: 0 0 120px;
}

.track-duration {
  flex: 0 0 44px;
}

/* Matches the rating + star + menu buttons' combined width in TrackRow.
 * The heart/menu buttons have no header label of their own, so the
 * "Rating" label is padded off the right edge by roughly their combined
 * width — lining it up over the star icons rather than the far edge. */
.track-actions {
  flex: 0 0 200px;
  padding-right: 76px;
}

.min-width-0 {
  min-width: 0;
}
</style>
