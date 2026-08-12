<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-music-note" :eyebrow="$t('library.track1')" :title="$t('library.tracks')">
      <template v-if="filteredTracks.length" #meta>
        {{ filteredTracks.length }}
        {{ filteredTracks.length === 1 ? $t('library.track1') : $t('library.tracksN') }}
      </template>
    </detail-header>

    <sticky-filter :z-index="3" :fade="false" @resize="stickyHeaderHeight = $event">
      <v-text-field
        v-model="filterQuery"
        :label="$t('common.filter')"
        prepend-inner-icon="mdi-filter-variant"
        variant="solo-filled"
        density="compact"
        clearable
        class="mb-4"
        style="max-width: 320px"
      />
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <track-list
      :tracks="filteredTracks"
      :loading="libraryStore.loading"
      :default-sort-key="libraryStore.allTracksLoaded ? 'title' : null"
      infinite-scroll
      sticky-header
      :style="{ '--sticky-header-offset': `${stickyHeaderHeight}px` }"
      :queue-whole-list="false"
      show-cover
      show-album
      show-genre
      show-year
      show-play-count
      show-format
    />

    <v-alert
      v-if="!libraryStore.loading && filteredTracks.length === 0"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('library.noTracksForQuery', { query: filterQuery })
          : $t('library.noTracksFound')
      }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import DetailHeader from '@/components/library/DetailHeader.vue'
import TrackList from '@/components/library/TrackList.vue'
import StickyFilter from '@/components/StickyFilter.vue'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'TracksView',
  components: { DetailHeader, TrackList, StickyFilter },
  data() {
    return {
      filterQuery: '',
      // filteredTracks reads this instead of filterQuery directly —
      // filtering (and TrackList's own re-sort) runs a full scan over
      // potentially tens of thousands of tracks, which if it ran
      // synchronously on every keystroke would block the very render pass
      // that's supposed to show the character just typed, making the input
      // itself feel laggy. filterQuery still updates instantly (it's just
      // the input's own text); only the actual filtering waits a beat.
      debouncedQuery: '',
      // Height of the sticky filter block, reported by StickyFilter's own
      // @resize — TrackList's sticky column header (see its stickyHeader
      // prop) needs this to stack correctly right below it instead of
      // overlapping it.
      stickyHeaderHeight: 0,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    // The full catalog is fetched once (fetchAllTracks) so filtering and
    // TrackList's column-sort both work across the whole library — TrackList
    // itself paginates the render, this just needs to hand over everything.
    filteredTracks() {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.allTracks
      return this.libraryStore.allTracks.filter(
        (track: { title: string; artist: string; album: string }) =>
          track.title.toLowerCase().includes(query) ||
          track.artist.toLowerCase().includes(query) ||
          track.album.toLowerCase().includes(query),
      )
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      // clearable's clear button sets the model to null, not '' — without
      // the fallback, the (unlikely but not impossible) case where nothing
      // ever debounces after a clear would leave the old filter applied.
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchAllTracks()
  },
}
</script>
