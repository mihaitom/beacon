<template>
  <div class="song-table-header d-flex align-center px-2 pb-1">
    <div class="song-index" />
    <div v-if="showCover" class="song-cover-spacer" />
    <div class="song-title min-width-0">
      <button type="button" class="sort-header" @click="$emit('sort', 'title')">
        {{ $t('library.title') }}
        <v-icon v-if="sortKey === 'title'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showAlbum" class="song-album">
      <button type="button" class="sort-header" @click="$emit('sort', 'album')">
        {{ $t('library.album') }}
        <v-icon v-if="sortKey === 'album'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showGenre" class="song-genre">
      <button type="button" class="sort-header" @click="$emit('sort', 'genre')">
        {{ $t('library.genre') }}
        <v-icon v-if="sortKey === 'genre'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showYear" class="song-year">
      <button type="button" class="sort-header" @click="$emit('sort', 'year')">
        {{ $t('library.year') }}
        <v-icon v-if="sortKey === 'year'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showPlayCount" class="song-playcount">
      <button type="button" class="sort-header" @click="$emit('sort', 'playCount')">
        {{ $t('library.plays') }}
        <v-icon v-if="sortKey === 'playCount'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div v-if="showFormat" class="song-format">
      <button type="button" class="sort-header" @click="$emit('sort', 'format')">
        {{ $t('library.format') }}
        <v-icon v-if="sortKey === 'format'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div class="song-duration">
      <button type="button" class="sort-header" @click="$emit('sort', 'duration')">
        {{ $t('library.duration') }}
        <v-icon v-if="sortKey === 'duration'" :icon="arrowIcon" size="12" class="ml-1" />
      </button>
    </div>
    <div class="song-actions">
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
.song-table-header {
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

/* Widths/flex-grow here must mirror SongRow.vue's exactly, column for
 * column, or the header labels drift out of alignment with the rows. */
.song-index {
  flex: 0 0 28px;
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
