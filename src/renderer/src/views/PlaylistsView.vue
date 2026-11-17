<template>
  <v-container fluid>
    <detail-header :title="$t('playlists.title')" stored-fanart>
      <template v-if="filteredPlaylists.length" #meta>
        {{ $n(filteredPlaylists.length) }}
        {{
          filteredPlaylists.length === 1 ? $t('playlists.playlist1') : $t('playlists.playlistsN')
        }}
      </template>
      <template v-if="authStore.capabilities.emptyPlaylistCreation" #actions>
        <div class="detail-header__actions-row">
          <!-- Always offered: Deezer and ListenBrainz need no setup, and the
           - builder only lists Last.fm once connect has a key for it. -->
          <v-btn
            prepend-icon="mdi-playlist-music"
            color="primary"
            rounded="pill"
            @click="openBuilder"
          >
            {{ $t('builder.title') }}
          </v-btn>
          <v-btn
            v-if="authStore.capabilities.smartPlaylistEditor"
            prepend-icon="mdi-auto-fix"
            color="primary"
            rounded="pill"
            to="/playlists/smart/new"
            >{{ $t('smartPlaylists.newButton') }}</v-btn
          >
          <v-btn prepend-icon="mdi-plus" color="primary" rounded="pill" @click="openCreate">{{
            $t('playlists.newPlaylist')
          }}</v-btn>
        </div>
      </template>
    </detail-header>

    <sticky-filter>
      <div class="library-filter">
        <v-text-field
          v-model="filterQuery"
          :placeholder="$t('search.label')"
          :aria-label="$t('search.label')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          rounded="pill"
          flat
          clearable
          hide-details
          class="library-search"
        />
        <v-btn-toggle
          v-if="segments.length"
          :model-value="activeSegment"
          mandatory
          class="beacon-view-toggle beacon-view-toggle--text"
          :aria-label="$t('playlists.segments')"
          @update:model-value="segment = $event"
        >
          <v-btn v-for="item in segments" :key="item.value" :value="item.value">
            {{ item.title }}
          </v-btn>
        </v-btn-toggle>
        <div class="library-controls">
          <v-btn-toggle
            :model-value="listView ? 'list' : 'grid'"
            mandatory
            class="beacon-view-toggle"
            :aria-label="$t('library.layout')"
            @update:model-value="setListView($event === 'list')"
          >
            <v-btn value="grid" icon="mdi-view-grid-outline" :title="$t('library.layoutGrid')" />
            <v-btn value="list" icon="mdi-view-list" :title="$t('library.layoutList')" />
          </v-btn-toggle>
          <library-sort-select
            :model-value="sort.key"
            :items="sortItems"
            :direction="sort.direction"
            @update:model-value="pickSort"
            @toggle-direction="toggleDirection"
          />
        </div>
      </div>
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="view-notice">
      {{ libraryStore.error }}
    </v-alert>
    <!-- Placeholders in the list's own place, not a spinner above it: a
     - spinner in the flow pushed everything below it down while it was
     - there. Only while there is genuinely nothing to show yet — the flag
     - is the library store's own, so any background fetch (a tile menu
     - loading a playlist's songs) sets it too, and swapping a full list for
     - placeholders because of one of those would be worse than the jump it
     - replaced. -->
    <div
      v-if="showSkeletons && listView"
      class="beacon-panel beacon-panel--flush playlists-view__list"
    >
      <row-skeleton v-for="n in SKELETON_ROWS" :key="n" :cover-size="112" />
    </div>
    <div v-else-if="showSkeletons" class="playlists-view__grid">
      <v-skeleton-loader
        v-for="n in SKELETON_ROWS"
        :key="n"
        type="image"
        class="playlists-view__skeleton"
      />
    </div>

    <template v-for="section in sections" :key="section.key">
      <h2 class="section-title">{{ section.title }}</h2>
      <div :class="containerClass">
        <playlist-card
          v-for="playlist in section.playlists"
          :key="playlist.id"
          :playlist="playlist"
          :row="listView"
          :show-owner="section.key === 'sharedWithMe'"
          @play="playPlaylist"
          @play-next="queuePlaylist($event, 'next')"
          @add-to-queue="queuePlaylist($event, 'end')"
          @rename="openRename"
          @delete="openDelete"
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

    <playlist-builder-dialog ref="builder" />
    <playlist-edit-dialog ref="editDialog" />
    <playlist-delete-dialog ref="deleteDialog" />

    <create-playlist-dialog ref="createDialog" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import EmptyState from '@/components/EmptyState.vue'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import PlaylistCard from '@/components/library/PlaylistCard.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import RowSkeleton from '@/components/library/RowSkeleton.vue'
import PlaylistEditDialog from '@/components/library/PlaylistEditDialog.vue'
import CreatePlaylistDialog from '@/components/library/CreatePlaylistDialog.vue'
import PlaylistBuilderDialog from '@/components/library/PlaylistBuilderDialog.vue'
import PlaylistDeleteDialog from '@/components/library/PlaylistDeleteDialog.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import {
  PLAYLIST_SORT_KEYS,
  availableSegments,
  defaultPlaylistDirection,
  inSegment,
  loadPlaylistSort,
  savePlaylistSort,
  sortPlaylists,
  playlistSectionsFor,
  type PlaylistSection,
  type PlaylistSegment,
  type PlaylistSort,
  type PlaylistSortKey,
} from '@/services/library/playlistBrowse'
import { readBooleanPreference, writeBooleanPreference } from '@/services/booleanPreference'
import type { Playlist } from '@/types/library'

const LIST_VIEW_KEY = 'beacon.playlistsListView'

// Enough placeholder rows to read as a list rather than as one stray box.
// No real count to key off yet — the list they stand in for is exactly what
// hasn't arrived — so this is a plain number.
const SKELETON_ROWS = 5

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'PlaylistsView',
  components: {
    EmptyState,
    DetailHeader,
    PlaylistCard,
    LibrarySortSelect,
    RowSkeleton,
    PlaylistEditDialog,
    CreatePlaylistDialog,
    PlaylistBuilderDialog,
    PlaylistDeleteDialog,
    StickyFilter,
  },
  data() {
    return {
      SKELETON_ROWS,
      filterQuery: '',
      // filteredPlaylists reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in SongsView.vue.
      debouncedQuery: '',
      segment: 'all' as PlaylistSegment,
      sort: loadPlaylistSort() as PlaylistSort,
      listView: readBooleanPreference(LIST_VIEW_KEY),
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    showSkeletons(): boolean {
      return this.libraryStore.loading && this.libraryStore.playlists.length === 0
    },
    segments(): { title: string; value: PlaylistSegment }[] {
      const titles = {
        all: 'segmentAll',
        mine: 'segmentMine',
        smart: 'segmentSmart',
        sharedByMe: 'sharedByMe',
        sharedWithMe: 'sharedWithMe',
      } as const
      return availableSegments(this.libraryStore.playlists, this.authStore.username).map(
        (value) => ({ title: this.$t(`playlists.${titles[value]}`), value }),
      )
    },
    /** Back to everything when the picked group has emptied, or its button
     * would be gone and the page stuck on an empty list. */
    activeSegment(): PlaylistSegment {
      return this.segments.some((item) => item.value === this.segment) ? this.segment : 'all'
    },
    sortItems(): { title: string; value: string }[] {
      return PLAYLIST_SORT_KEYS.map((key) => ({
        title: this.$t(key === 'changed' ? 'playlists.sortChanged' : `library.albumSort.${key}`),
        value: key,
      }))
    },
    containerClass(): string {
      return this.listView
        ? 'beacon-panel beacon-panel--flush playlists-view__list'
        : 'playlists-view__grid'
    },
    filteredPlaylists(): Playlist[] {
      const query = this.debouncedQuery
      const matching = this.libraryStore.playlists.filter(
        (playlist: Playlist) =>
          inSegment(playlist, this.activeSegment, this.authStore.username) &&
          // Always exact: a playlist is found by its name, and the list is
          // short enough that a misspelling is worth correcting rather than
          // guessing around.
          (!query.trim() || matchesAllTerms(query, [playlist.name], { exact: true })),
      )
      return sortPlaylists(matching, this.sort)
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
    setListView(listView: boolean): void {
      this.listView = listView
      writeBooleanPreference(LIST_VIEW_KEY, listView)
    },
    pickSort(key: string): void {
      const sortKey = key as PlaylistSortKey
      this.setSort({ key: sortKey, direction: defaultPlaylistDirection(sortKey) })
    },
    toggleDirection(): void {
      this.setSort({
        key: this.sort.key,
        direction: this.sort.direction === 'asc' ? 'desc' : 'asc',
      })
    },
    setSort(sort: PlaylistSort): void {
      this.sort = sort
      savePlaylistSort(sort)
    },
    openCreate(): void {
      ;(this.$refs.createDialog as { open: (songIds: string[]) => void } | undefined)?.open([])
    },
    openBuilder(): void {
      ;(this.$refs.builder as { open: () => void } | undefined)?.open()
    },
    async playPlaylist(playlist: Playlist) {
      // getPlaylists.view (the list this view renders) doesn't include each
      // playlist's songs — only getPlaylist.view for a single id does —
      // so the full song list has to be fetched before it can be queued.
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await usePlaybackStore().playSongList(full.songs, 0, false, full.songs.length > 1)
    },
    /** Queueing a playlist needs its songs, which the list this view
     * renders doesn't carry — same fetch playPlaylist() above makes. */
    async queuePlaylist(playlist: Playlist, where: 'next' | 'end') {
      const playback = usePlaybackStore()
      try {
        const full = await this.libraryStore.fetchPlaylist(playlist.id)
        if (!full.songs.length) return
        if (where === 'next') playback.queueNext(full.songs)
        else playback.addToQueue(full.songs)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: playlist.name,
          message: this.$t('library.songsUnavailable'),
        })
        console.error('[playlists] Failed to load playlist songs:', error)
      }
    },
    openRename(playlist: Playlist) {
      ;(this.$refs.editDialog as { open: (playlist: Playlist) => void } | undefined)?.open(playlist)
    },
    openDelete(playlist: Playlist) {
      ;(this.$refs.deleteDialog as { open: (playlist: Playlist) => void } | undefined)?.open(
        playlist,
      )
    },
  },
}
</script>

<style scoped>
/* A heading sits close to the list it names; the lists themselves are
 * further apart, so "Personal" and "Shared" read as two blocks. */
.section-title {
  margin-bottom: 8px;
}

.playlists-view__list {
  margin-bottom: 24px;
}

/* The gaps are wide because a record falling forward swings out past its
 * own column, and its glow needs somewhere to land. */
.playlists-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 44px 36px;
  margin: 18px 0 40px;
}

/* A front record and the two edges behind it: PlaylistCard's own stack. */
.playlists-view__skeleton {
  aspect-ratio: 1 / 1.15;
  background: transparent;
}

.playlists-view__skeleton :deep(.v-skeleton-loader__bone) {
  height: 100%;
  margin: 0;
}

.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
