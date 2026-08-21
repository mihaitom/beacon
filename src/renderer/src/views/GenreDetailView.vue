<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-music-note" :eyebrow="$t('library.genre')" :title="genreName">
      <template v-if="songs.length" #meta>
        {{ $t('library.albumsAndSongs', { albums: albumCount, songs: songs.length }) }}
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

    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <template v-else>
      <song-table
        :songs="filteredSongs"
        :queue-whole-list="false"
        sticky-header
        :style="{ '--sticky-header-offset': `${stickyHeaderHeight}px` }"
        show-cover
        show-album
        show-year
        show-play-count
        show-format
      />
      <v-alert v-if="filteredSongs.length === 0" type="info" variant="tonal">
        {{
          filterQuery
            ? $t('library.noSongsForQuery', { query: filterQuery })
            : $t('library.noSongsFound')
        }}
      </v-alert>
    </template>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { shuffled } from '@/services/shuffle'
import DetailHeader from '@/components/library/DetailHeader.vue'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Song } from '@/types/library'

const RANDOM_PLAY_COUNT = 100
// See SongsView.vue's identical TOP_SONGS_POOL_SIZE comment — same
// reasoning, scoped to just this genre's own songs instead of the whole
// library.
const TOP_SONGS_POOL_SIZE = 1000

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'GenreDetailView',
  components: { DetailHeader, SongTable, PageLoader, StickyFilter },
  data() {
    return {
      songs: [] as Song[],
      filterQuery: '',
      // filteredSongs reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in SongsView.vue.
      debouncedQuery: '',
      // Height of the sticky filter block, reported by StickyFilter's own
      // @resize — SongTable's sticky column header (see its stickyHeader
      // prop) needs this to stack correctly right below it instead of
      // overlapping it. Same wiring as SongsView.vue.
      stickyHeaderHeight: 0,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    genreName(): string {
      return decodeURIComponent(this.$route.params.name as string)
    },
    albumCount(): number {
      return new Set(this.songs.map((song) => song.albumId)).size
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.songs
      return this.songs.filter(
        (song) =>
          song.title.toLowerCase().includes(query) ||
          song.artist.toLowerCase().includes(query) ||
          song.album.toLowerCase().includes(query),
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
    '$route.params.name': 'loadSongs',
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
      await playbackStore.playSongList(sample, 0, false)
      // A pick the user didn't make song-by-song themselves — see
      // peekQueueDrawer()'s own comment for why this opens the drawer.
      playbackStore.peekQueueDrawer()
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
      await playbackStore.playSongList(sample, 0, false)
      playbackStore.peekQueueDrawer()
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
