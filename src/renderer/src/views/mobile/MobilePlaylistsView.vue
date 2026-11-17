<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('playlists.title') }}</h1>
    </div>

    <!-- Sticky, the same as the library's and Radio's own filters. -->
    <sticky-filter>
      <v-text-field
        v-model="filterQuery"
        :label="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        hide-details
      />
    </sticky-filter>

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="view-notice" />

    <template v-for="section in sections" :key="section.key">
      <h2 class="section-title">{{ section.title }}</h2>
      <div class="mobile-playlist-list">
        <mobile-playlist-row
          v-for="playlist in section.playlists"
          :key="playlist.id"
          :playlist="playlist"
          :show-owner="section.key === 'sharedWithMe'"
          @play="play"
        />
      </div>
    </template>

    <empty-state
      v-if="!libraryStore.loading && !sections.length"
      :icon="filterQuery ? 'mdi-magnify-close' : 'mdi-playlist-music-outline'"
      :title="
        filterQuery
          ? $t('playlists.noPlaylistsForQuery', { query: filterQuery })
          : $t('playlists.noPlaylistsYet')
      "
    />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import EmptyState from '@/components/EmptyState.vue'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import MobilePlaylistRow from '@/components/mobile/MobilePlaylistRow.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import { playlistSectionsFor, type PlaylistSection } from '@/services/library/playlistBrowse'
import type { Playlist } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobilePlaylistsView',
  components: { EmptyState, MobilePlaylistRow, StickyFilter },
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
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.playlists
      return this.libraryStore.playlists.filter((playlist: Playlist) =>
        matchesAllTerms(query, [playlist.name], { exact: true }),
      )
    },
    sections(): PlaylistSection[] {
      return playlistSectionsFor(
        this.filteredPlaylists,
        this.authStore.username,
        this.$t.bind(this),
      )
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
      // pinFirst: false — see desktop PlaylistDetailView.vue's identical comment.
      await usePlaybackStore().playSongList(full.songs, 0, false)
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

/* A heading sits right on top of its own list; the lists themselves
 * are further apart. */
.section-title {
  margin-bottom: 4px;
}

.mobile-playlist-list {
  margin-bottom: 16px;
}
</style>
