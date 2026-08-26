<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-music-note" :title="$t('library.songs')">
      <template v-if="filteredSongs.length" #meta>
        {{ filteredSongs.length }}
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
      <v-text-field
        v-model="filterQuery"
        :label="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
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
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
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
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.allSongs
      return this.libraryStore.allSongs.filter(
        (song: { title: string; artist: string; album: string }) =>
          matchesAllTerms(query, song.title, song.artist, song.album),
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
/* See AlbumsView.vue's identical rule. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
