<template>
  <v-container fluid>
    <h1 class="page-title mb-3">{{ $t('library.tracks') }}</h1>

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

    <div class="mobile-tracks__list">
      <mobile-track-row
        v-for="(track, index) in visibleTracks"
        :key="track.id"
        :track="track"
        @play="play(index)"
        @toggle-star="toggleStar(track)"
        @open-actions="openActions(track)"
      />
    </div>

    <v-btn v-if="visibleTracks.length < filteredTracks.length" block variant="tonal" class="mt-3" @click="pageSize += PAGE_SIZE">
      {{ $t('common.loadMore') }}
    </v-btn>

    <v-alert v-if="!libraryStore.loading && filteredTracks.length === 0" type="info" variant="tonal">
      {{
        filterQuery
          ? $t('library.noTracksForQuery', { query: filterQuery })
          : $t('library.noTracksFound')
      }}
    </v-alert>

    <mobile-track-action-sheet v-model="actionsOpen" :track="activeTrack" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileTrackRow from '@/components/mobile/MobileTrackRow.vue'
import MobileTrackActionSheet from '@/components/mobile/MobileTrackActionSheet.vue'
import type { Track } from '@/types/library'

// Rendered as a plain list (no virtualization, unlike desktop's TrackList.vue
// v-virtual-scroll) — simple "load more" paging keeps a 20k+-track catalog
// from ever mounting more rows at once than a phone needs to scroll through,
// same idea the LAN remote's own tracks view already validated.
const PAGE_SIZE = 50

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobileTracksView',
  components: { MobileTrackRow, MobileTrackActionSheet },
  data() {
    return {
      PAGE_SIZE,
      filterQuery: '',
      debouncedQuery: '',
      pageSize: PAGE_SIZE,
      actionsOpen: false,
      activeTrack: null as Track | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    filteredTracks(): Track[] {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.allTracks
      return this.libraryStore.allTracks.filter(
        (track: Track) =>
          track.title.toLowerCase().includes(query) ||
          track.artist.toLowerCase().includes(query) ||
          track.album.toLowerCase().includes(query),
      )
    },
    visibleTracks(): Track[] {
      return this.filteredTracks.slice(0, this.pageSize)
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
    this.libraryStore.fetchAllTracks()
  },
  methods: {
    async play(index: number) {
      await usePlaybackStore().playTrackList(this.visibleTracks, index)
    },
    async toggleStar(track: Track) {
      await this.libraryStore.toggleStar({ id: track.id, starred: track.starred })
      track.starred = !track.starred
    },
    openActions(track: Track) {
      this.activeTrack = track
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-tracks__list {
  display: flex;
  flex-direction: column;
}
</style>
