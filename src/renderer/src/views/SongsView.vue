<template>
  <v-container fluid>
    <detail-header :title="$t('library.songs')" stored-fanart>
      <template v-if="filteredSongs.length" #meta>
        {{ $n(filteredSongs.length) }}
        {{ filteredSongs.length === 1 ? $t('library.song1') : $t('library.songsN') }}
      </template>
      <!-- See AlbumsView.vue's identical #actions template comment for why
       - this wrapper exists. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-shuffle-variant"
            :disabled="!libraryStore.allSongs.length"
            @click="playRandom"
          >
            {{ $t('library.playRandom') }}
          </v-btn>
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-trending-up"
            :disabled="!libraryStore.allSongs.length"
            @click="playTopSongs"
          >
            {{ $t('library.playFromTopPlayed') }}
          </v-btn>
        </div>
      </template>
    </detail-header>

    <sticky-filter :z-index="3" :fade="false" @resize="stickyHeaderHeight = $event">
      <!-- In the sticky block rather than above the list: the list is long,
       - and an error at its top was out of sight once you had scrolled. -->
      <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="songs-error">
        {{ libraryStore.error }}
      </v-alert>
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
        <div class="songs-controls">
          <library-filter-menu
            v-model="filters"
            :items="libraryStore.allSongs"
            :fields="filterFields"
          />
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
    <song-table
      :songs="filteredSongs"
      :loading="libraryStore.loading"
      :sort="tableSort"
      sectioned
      sticky-header
      :style="{ '--sticky-header-offset': `${stickyHeaderHeight}px` }"
      :queue-whole-list="false"
    />

    <empty-state
      v-if="!libraryStore.loading && filteredSongs.length === 0"
      :icon="filterQuery ? 'mdi-magnify-close' : 'mdi-music-note-off'"
      :title="
        filterQuery
          ? $t('library.noSongsForQuery', { query: filterQuery })
          : $t('library.noSongsFound')
      "
    />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { filterSongs } from '@/services/library/songBrowse'
import { songBrowsingMixin } from '@/components/library/songBrowsing'
import LibraryFilterMenu from '@/components/library/LibraryFilterMenu.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import EmptyState from '@/components/EmptyState.vue'
import { usePlaybackStore } from '@/stores/playback'
import { shuffled } from '@/services/shuffle'
import { rankByMatch } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
import SongTable from '@/components/library/SongTable.vue'
import StickyFilter from '@/components/StickyFilter.vue'

const RANDOM_PLAY_COUNT = 100
// Deliberately not "top 100" — with the pool exactly as big as what gets
// played, "random from top played" would always be the same 100 songs,
// no variance between clicks. 1000 keeps enough room for that variance
// while still meaning "actually popular", not just "everything". Not
// shown in the button label (library.playFromTopPlayed) — the exact
// number is an implementation detail, not worth exposing.
const TOP_SONGS_POOL_SIZE = 1000

export default {
  name: 'SongsView',
  components: {
    EmptyState,
    DetailHeader,
    ExactMatchSwitch,
    LibraryFilterMenu,
    LibrarySortSelect,
    SongTable,
    StickyFilter,
  },
  mixins: [songBrowsingMixin],
  data() {
    return {
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
    browsedSongs() {
      return filterSongs(this.libraryStore.allSongs, this.filters)
    },
    // The full catalog is fetched once (fetchAllSongs) so filtering and
    // sorting both work across the whole library — SongTable itself
    // paginates the render, this just needs to hand over everything.
    filteredSongs() {
      const query = this.debouncedQuery
      if (!query.trim()) return this.browsedSongs
      // Ranked by how well each song answers the query, best first, the same
      // way the search page ranks its results - a plain alphabetical order
      // buries an exact title among the rest.
      return rankByMatch(
        this.browsedSongs,
        query,
        (song: { title: string; artist: string; album: string }) => [
          { text: song.title, weight: 2 },
          { text: song.artist },
          { text: song.album, weight: 0.5 },
        ],
        { exact: this.libraryStore.searchExact },
      )
    },
  },
  created() {
    this.libraryStore.fetchAllSongs()
  },
  methods: {
    // The catalog streams in page by page (fetchAllSongs).
    listComplete(): boolean {
      return this.libraryStore.allSongsLoaded
    },
    // Samples from the full unfiltered catalog, same as GenreDetailView's
    // identical playRandom() — an active filter narrows what's browsable,
    // not what "random" draws from.
    async playRandom() {
      if (!this.libraryStore.allSongs.length) return
      const sample = shuffled(this.libraryStore.allSongs).slice(0, RANDOM_PLAY_COUNT)
      const playbackStore = usePlaybackStore()
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: a pick the user didn't make song-by-song themselves — see
      // peekQueueDrawer()'s own comment for why that opens the drawer.
      await playbackStore.playSongList(sample, 0, false, true)
    },
    // Same idea as AlbumsView.vue's/ArtistsView.vue's own "Random from top
    // played", scaled up: songs are cheap to rank client-side (the full
    // catalog is already loaded, see created()), so this narrows to the
    // TOP_SONGS_POOL_SIZE most-played songs (excluding never-played ones
    // entirely, same as StatsView's own rankings) before sampling
    // RANDOM_PLAY_COUNT of those at random, instead of needing a
    // server-side "frequent" endpoint the way albums do.
    async playTopSongs() {
      const played = this.libraryStore.allSongs.filter((song) => song.playCount > 0)
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
.songs-error {
  margin-bottom: 12px;
}

.songs-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-left: auto;
}

/* Clear of the index bar down the right edge, as on Albums. */
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
