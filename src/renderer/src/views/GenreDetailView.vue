<template>
  <v-container fluid>
    <detail-header :eyebrow="$t('library.genre')" :title="genreName" :stored-fanart="genreArtists">
      <template v-if="songs.length" #meta>
        {{ $t('library.albumsAndSongs', { albums: $n(albumCount), songs: $n(songs.length) }) }}
      </template>
      <!-- See AlbumsView.vue's identical #actions template comment for why
       - this wrapper exists. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-shuffle-variant"
            :disabled="!songs.length"
            @click="playRandom"
          >
            {{ $t('library.playRandom') }}
          </v-btn>
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-trending-up"
            :disabled="!songs.length"
            @click="playTopSongs"
          >
            {{ $t('library.playFromTopPlayed') }}
          </v-btn>
        </div>
      </template>
    </detail-header>

    <sticky-filter :z-index="3" :fade="false" @resize="stickyHeaderHeight = $event">
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
        >
          <template #append-inner><exact-match-switch /></template>
        </v-text-field>
        <div class="genre-controls">
          <v-btn-toggle
            :model-value="gridView ? 'grid' : 'list'"
            mandatory
            class="beacon-view-toggle"
            :aria-label="$t('library.layout')"
            @update:model-value="setGridView($event === 'grid')"
          >
            <v-btn value="grid" icon="mdi-view-grid-outline" :title="$t('library.layoutGrid')" />
            <v-btn value="list" icon="mdi-view-list" :title="$t('library.layoutList')" />
          </v-btn-toggle>
          <library-filter-menu v-model="filters" :items="songs" :fields="filterFields" />
          <library-sort-select
            :model-value="sortValue"
            :items="sortItems"
            :direction="byRelevance ? null : sort.direction"
            @update:model-value="pickSort"
            @toggle-direction="toggleDirection"
          />
        </div>
      </div>
    </sticky-filter>

    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal" class="view-notice">
      {{ libraryStore.error }}
    </v-alert>
    <template v-else>
      <song-table
        :songs="filteredSongs"
        :queue-whole-list="false"
        :sort="tableSort"
        sectioned
        :grid="gridView"
        sticky-header
        :style="{ '--sticky-header-offset': `${stickyHeaderHeight}px` }"
        :exclude-columns="['genre']"
      />
      <empty-state
        v-if="filteredSongs.length === 0"
        :icon="filterQuery ? 'mdi-magnify-close' : 'mdi-music-note-off'"
        :title="
          filterQuery
            ? $t('library.noSongsForQuery', { query: filterQuery })
            : $t('library.noSongsFound')
        "
      />
    </template>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import EmptyState from '@/components/EmptyState.vue'
import { usePlaybackStore } from '@/stores/playback'
import { shuffled } from '@/services/shuffle'
import { rankByMatch } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
import LibraryFilterMenu from '@/components/library/LibraryFilterMenu.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import { songBrowsingMixin } from '@/components/library/songBrowsing'
import { filterSongs } from '@/services/library/songBrowse'
import type { FilterField } from '@/services/library/libraryFilter'
import type { Song } from '@/types/library'

const RANDOM_PLAY_COUNT = 100
// See SongsView.vue's identical TOP_SONGS_POOL_SIZE comment — same
// reasoning, scoped to just this genre's own songs instead of the whole
// library.
const TOP_SONGS_POOL_SIZE = 1000

export default {
  name: 'GenreDetailView',
  components: {
    EmptyState,
    DetailHeader,
    SongTable,
    PageLoader,
    StickyFilter,
    ExactMatchSwitch,
    LibraryFilterMenu,
    LibrarySortSelect,
  },
  mixins: [songBrowsingMixin],
  data() {
    return {
      songs: [] as Song[],
      excludedFilterFields: ['genre'] as FilterField[],
      // Height of the sticky filter block, reported by StickyFilter's own
      // @resize — SongTable's sticky column header (see its stickyHeader
      // prop) needs this to stack correctly right below it instead of
      // overlapping it. Same wiring as SongsView.vue.
      stickyHeaderHeight: 0,
    }
  },
  computed: {
    /** Who the genre's songs are by - its header cycles through the stored
     * Fanart.tv backgrounds of these artists only. */
    genreArtists(): string[] {
      return [...new Set(this.songs.map((song) => song.artist))].sort()
    },
    libraryStore() {
      return useLibraryStore()
    },
    genreName(): string {
      return decodeURIComponent(this.$route.params.name as string)
    },
    albumCount(): number {
      return new Set(this.songs.map((song) => song.albumId)).size
    },
    browsedSongs(): Song[] {
      return filterSongs(this.songs, this.filters)
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.browsedSongs
      // Ranked by match, best first, like the main song list and the search
      // page - SongTable's title sort would bury an exact title.
      return rankByMatch(
        this.browsedSongs,
        query,
        (song) => [
          { text: song.title, weight: 2 },
          { text: song.artist },
          { text: song.album, weight: 0.5 },
        ],
        { exact: this.libraryStore.searchExact },
      )
    },
  },
  watch: {
    // Another genre's songs: what was picked for this one may not exist there.
    '$route.params.name'() {
      this.filters = {}
      this.loadSongs()
    },
  },
  created() {
    this.loadSongs()
  },
  methods: {
    async loadSongs() {
      const name = this.genreName
      try {
        const songs = await this.libraryStore.fetchSongsByGenre(name)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.genreName === name) this.songs = songs
      } catch (error) {
        if (this.genreName !== name) return
        console.error('[genre-detail] Failed to load songs:', error)
      }
    },
    async playRandom() {
      if (!this.songs.length) return
      const sample = shuffled(this.songs).slice(0, RANDOM_PLAY_COUNT)
      const playbackStore = usePlaybackStore()
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: a pick the user didn't make song-by-song themselves — see
      // peekQueueDrawer()'s own comment for why that opens the drawer.
      await playbackStore.playSongList(sample, 0, false, true)
    },
    // See SongsView.vue's identical playTopSongs() comment.
    async playTopSongs() {
      const played = this.songs.filter((song) => song.playCount > 0)
      if (!played.length) return
      const pool = [...played]
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, TOP_SONGS_POOL_SIZE)
      const sample = shuffled(pool).slice(0, RANDOM_PLAY_COUNT)
      const playbackStore = usePlaybackStore()
      // pinFirst: false — see playRandom()'s identical comment.
      await playbackStore.playSongList(sample, 0, false, true)
    },
  },
}
</script>

<style scoped>
.genre-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-left: auto;
}

/* Clear of the index bar down the right edge, as on Songs. */
.library-filter {
  margin-right: 40px;
}

/* See AlbumsView.vue's identical rule. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
