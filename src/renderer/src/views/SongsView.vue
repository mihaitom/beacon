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
          <song-filter-menu
            v-model="filters"
            :songs="libraryStore.allSongs"
            :fields="filterFields"
          />
          <v-select
            :model-value="sortValue"
            :items="sortItems"
            :aria-label="$t('library.sortBy')"
            prepend-inner-icon="mdi-sort"
            variant="solo-filled"
            density="compact"
            rounded="pill"
            flat
            hide-details
            class="song-sort"
            @update:model-value="pickSort"
          >
            <template v-if="!byRelevance" #append-inner>
              <v-btn
                :icon="sort.direction === 'desc' ? 'mdi-arrow-down' : 'mdi-arrow-up'"
                :title="$t(`library.songSort.${sort.direction}`)"
                :aria-label="$t(`library.songSort.${sort.direction}`)"
                variant="text"
                size="x-small"
                @click.stop="toggleDirection"
                @mousedown.stop
              />
            </template>
          </v-select>
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
import { useAuthStore } from '@/stores/auth'
import {
  defaultDirection,
  filterFieldsFor,
  filterSongs,
  loadSongSort,
  saveSongSort,
  sortKeysFor,
  sortLabelKey,
  type FilterFieldDef,
  type SongFilters,
  type SongSort,
  type SongSortKey,
} from '@/services/library/songBrowse'
import SongFilterMenu from '@/components/library/SongFilterMenu.vue'
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

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'SongsView',
  components: {
    EmptyState,
    DetailHeader,
    ExactMatchSwitch,
    SongFilterMenu,
    SongTable,
    StickyFilter,
  },
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
      sort: loadSongSort(),
      // While a search is typed, the results come ranked by match and the
      // menu says so, until another order is picked.
      byRelevance: false,
      // Set once an order is picked before the catalog has finished
      // loading - from then on it applies straight away, not only once the
      // last page is in (see tableSort).
      sortPicked: false,
      filters: {} as SongFilters,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    filterFields(): FilterFieldDef[] {
      return filterFieldsFor(this.authStore.serverType).filter(
        (def) => def.field !== 'rating' || this.authStore.capabilities.personalRating,
      )
    },
    browsedSongs() {
      return filterSongs(this.libraryStore.allSongs, this.filters)
    },
    // The full catalog is fetched once (fetchAllSongs) so filtering and
    // SongTable's column-sort both work across the whole library — SongTable
    // itself paginates the render, this just needs to hand over everything.
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
    /** Null keeps the list as handed over: ranked by match while a search
     * is on, and in arrival order while the catalog is still streaming in,
     * so rows already on screen are not reshuffled by every page that
     * arrives. */
    tableSort(): SongSort | null {
      if (this.byRelevance) return null
      if (!this.libraryStore.allSongsLoaded && !this.sortPicked) return null
      return this.sort
    },
    sortKeys(): SongSortKey[] {
      return sortKeysFor(this.authStore.serverType).filter(
        (key) => key !== 'rating' || this.authStore.capabilities.personalRating,
      )
    },
    sortValue(): string {
      return this.byRelevance ? 'relevance' : this.sort.key
    },
    sortItems(): { title: string; value: string }[] {
      const items = this.sortKeys.map((key): { title: string; value: string } => ({
        title: this.$t(sortLabelKey(key)),
        value: key,
      }))
      if (this.debouncedQuery.trim()) {
        items.unshift({ title: this.$t('library.songSort.relevance'), value: 'relevance' })
      }
      return items
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
    debouncedQuery(query: string, previous: string) {
      const searching = Boolean(query.trim())
      if (searching !== Boolean(previous.trim())) this.byRelevance = searching
    },
  },
  created() {
    // An order saved on a server that has data for it, kept on one that has none.
    if (!this.sortKeys.includes(this.sort.key)) this.sort = { key: 'title', direction: 'asc' }
    this.libraryStore.fetchAllSongs()
  },
  methods: {
    pickSort(value: string) {
      if (value === 'relevance') {
        this.byRelevance = true
        return
      }
      const key = value as SongSortKey
      this.applySort({ key, direction: defaultDirection(key) })
    },
    toggleDirection() {
      this.applySort({
        key: this.sort.key,
        direction: this.sort.direction === 'asc' ? 'desc' : 'asc',
      })
    },
    applySort(sort: SongSort) {
      this.byRelevance = false
      this.sortPicked = true
      this.sort = sort
      saveSongSort(sort)
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

.song-sort {
  flex: 0 0 220px;
}

/* See AlbumsView.vue's identical rule. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
