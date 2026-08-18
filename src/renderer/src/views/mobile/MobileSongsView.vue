<template>
  <v-container fluid>
    <h1 class="page-title mb-3">{{ $t('library.songs') }}</h1>

    <v-text-field
      v-model="filterQuery"
      :label="$t('common.filter')"
      prepend-inner-icon="mdi-filter-variant"
      variant="solo-filled"
      density="compact"
      clearable
      class="mb-3"
    />

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <div class="mobile-songs__list">
      <mobile-song-row
        v-for="(song, index) in visibleSongs"
        :key="song.id"
        :song="song"
        @play="play(index)"
        @toggle-star="toggleStar(song)"
        @open-actions="openActions(song)"
      />
    </div>

    <v-btn
      v-if="visibleSongs.length < filteredSongs.length"
      block
      variant="tonal"
      class="mt-3"
      @click="pageSize += PAGE_SIZE"
    >
      {{ $t('common.loadMore') }}
    </v-btn>

    <v-alert v-if="!libraryStore.loading && filteredSongs.length === 0" type="info" variant="tonal">
      {{
        filterQuery
          ? $t('library.noSongsForQuery', { query: filterQuery })
          : $t('library.noSongsFound')
      }}
    </v-alert>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import type { Song } from '@/types/library'

// Rendered as a plain list (no virtualization, unlike desktop's SongTable.vue
// v-virtual-scroll) — simple "load more" paging keeps a 20k+-song catalog
// from ever mounting more rows at once than a phone needs to scroll through,
// same idea the LAN remote's own songs view already validated.
const PAGE_SIZE = 50

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobileSongsView',
  components: { MobileSongRow, MobileSongActionSheet },
  data() {
    return {
      PAGE_SIZE,
      filterQuery: '',
      debouncedQuery: '',
      pageSize: PAGE_SIZE,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.allSongs
      return this.libraryStore.allSongs.filter(
        (song: Song) =>
          song.title.toLowerCase().includes(query) ||
          song.artist.toLowerCase().includes(query) ||
          song.album.toLowerCase().includes(query),
      )
    },
    visibleSongs(): Song[] {
      return this.filteredSongs.slice(0, this.pageSize)
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
        this.pageSize = PAGE_SIZE
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchAllSongs()
  },
  methods: {
    async play(index: number) {
      await usePlaybackStore().playSongList(this.visibleSongs, index)
    },
    async toggleStar(song: Song) {
      await this.libraryStore.toggleStar({ id: song.id, starred: song.starred })
      song.starred = !song.starred
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-songs__list {
  display: flex;
  flex-direction: column;
}
</style>
