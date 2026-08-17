<template>
  <v-container fluid>
    <h1 class="page-title mb-3">{{ $t('playlists.title') }}</h1>

    <v-text-field
      v-model="filterQuery"
      :label="$t('common.filter')"
      prepend-inner-icon="mdi-filter-variant"
      variant="solo-filled"
      density="compact"
      clearable
      class="mb-4"
    />

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <template v-if="personalPlaylists.length">
      <h2 class="section-title mb-1">{{ $t('playlists.personal') }}</h2>
      <div class="mobile-playlist-list mb-4">
        <mobile-playlist-row
          v-for="playlist in personalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          @play="play"
        />
      </div>
    </template>

    <template v-if="globalPlaylists.length">
      <h2 class="section-title mb-1">{{ $t('playlists.global') }}</h2>
      <div class="mobile-playlist-list">
        <mobile-playlist-row
          v-for="playlist in globalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          show-owner
          @play="play"
        />
      </div>
    </template>

    <v-alert
      v-if="!libraryStore.loading && !personalPlaylists.length && !globalPlaylists.length"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('playlists.noPlaylistsForQuery', { query: filterQuery })
          : $t('playlists.noPlaylistsYet')
      }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import MobilePlaylistRow from '@/components/mobile/MobilePlaylistRow.vue'
import type { Playlist } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobilePlaylistsView',
  components: { MobilePlaylistRow },
  data() {
    return {
      filterQuery: '',
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    filteredPlaylists(): Playlist[] {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.playlists
      return this.libraryStore.playlists.filter((playlist: Playlist) =>
        playlist.name.toLowerCase().includes(query),
      )
    },
    personalPlaylists(): Playlist[] {
      return this.filteredPlaylists.filter((p) => p.owner === this.authStore.username)
    },
    globalPlaylists(): Playlist[] {
      return this.filteredPlaylists.filter((p) => p.owner !== this.authStore.username)
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchPlaylists()
  },
  methods: {
    async play(playlist: Playlist) {
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      await usePlaybackStore().playTrackList(full.tracks, 0)
    },
  },
}
</script>

<style scoped>
.mobile-playlist-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
