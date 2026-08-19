<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-music-note" :title="$t('library.songs')">
      <template v-if="filteredSongs.length" #meta>
        {{ filteredSongs.length }}
        {{ filteredSongs.length === 1 ? $t('library.song1') : $t('library.songsN') }}
      </template>
      <template #actions>
        <v-btn
          color="primary"
          rounded="pill"
          prepend-icon="mdi-shuffle-variant"
          :disabled="!libraryStore.allSongs.length"
          @click="playRandom"
        >
          {{ $t('library.playRandom') }}
        </v-btn>
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
    <song-table
      :songs="filteredSongs"
      :loading="libraryStore.loading"
      :default-sort-key="libraryStore.allSongsLoaded ? 'title' : null"
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

    <v-alert v-if="!libraryStore.loading && filteredSongs.length === 0" type="info" variant="tonal">
      {{
        filterQuery
          ? $t('library.noSongsForQuery', { query: filterQuery })
          : $t('library.noSongsFound')
      }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { shuffled } from '@/services/shuffle'
import DetailHeader from '@/components/library/DetailHeader.vue'
import SongTable from '@/components/library/SongTable.vue'
import StickyFilter from '@/components/StickyFilter.vue'

const RANDOM_PLAY_COUNT = 100

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'SongsView',
  components: { DetailHeader, SongTable, StickyFilter },
  data() {
    return {
      filterQuery: '',
      // filteredSongs reads this instead of filterQuery directly —
      // filtering (and SongTable's own re-sort) runs a full scan over
      // potentially tens of thousands of songs, which if it ran
      // synchronously on every keystroke would block the very render pass
      // that's supposed to show the character just typed, making the input
      // itself feel laggy. filterQuery still updates instantly (it's just
      // the input's own text); only the actual filtering waits a beat.
      debouncedQuery: '',
      // Height of the sticky filter block, reported by StickyFilter's own
      // @resize — SongTable's sticky column header (see its stickyHeader
      // prop) needs this to stack correctly right below it instead of
      // overlapping it.
      stickyHeaderHeight: 0,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    // The full catalog is fetched once (fetchAllSongs) so filtering and
    // SongTable's column-sort both work across the whole library — SongTable
    // itself paginates the render, this just needs to hand over everything.
    filteredSongs() {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.allSongs
      return this.libraryStore.allSongs.filter(
        (song: { title: string; artist: string; album: string }) =>
          song.title.toLowerCase().includes(query) ||
          song.artist.toLowerCase().includes(query) ||
          song.album.toLowerCase().includes(query),
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
    this.libraryStore.fetchAllSongs()
  },
  methods: {
    // Samples from the full unfiltered catalog, same as GenreDetailView's
    // identical playRandom() — an active filter narrows what's browsable,
    // not what "random" draws from.
    async playRandom() {
      if (!this.libraryStore.allSongs.length) return
      const sample = shuffled(this.libraryStore.allSongs).slice(0, RANDOM_PLAY_COUNT)
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      await usePlaybackStore().playSongList(sample, 0, false)
    },
  },
}
</script>
