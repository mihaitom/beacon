<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-account-music" :title="$t('library.artists')">
      <template v-if="filteredArtists.length" #meta>
        {{ filteredArtists.length }}
        {{ filteredArtists.length === 1 ? $t('library.artist') : $t('library.artists') }}
      </template>
      <!-- See AlbumsView.vue's identical #actions template comment for why
       - this wrapper exists. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-shuffle-variant"
            :loading="playingRandomArtist"
            :disabled="!libraryStore.artists.length"
            @click="playRandomArtist"
          >
            {{ $t('library.playRandom') }}
          </v-btn>
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-trending-up"
            :loading="playingTopArtist"
            :disabled="!libraryStore.artists.length"
            @click="playTopArtist"
          >
            {{ $t('library.playFromTopPlayed') }}
          </v-btn>
        </div>
      </template>
    </detail-header>

    <sticky-filter>
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
    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <div
      ref="gridRoot"
      :class="{
        'grid-root--with-alphabet-bar': !libraryStore.loading && filteredArtists.length > 0,
      }"
    >
      <div v-if="!virtualizeArtists" class="artist-grid">
        <artist-card
          v-for="(artist, index) in visibleArtists"
          :key="artist.id"
          :data-artist-index="index"
          :artist="artist"
        />
      </div>
      <!-- See AlbumsView.vue's identical v-virtual-scroll comment for why
       - this exists and how the row-chunking/paddingTop works — same
       - pattern, just artist-sized dimensions. -->
      <v-virtual-scroll
        v-else
        ref="virtualScroll"
        renderless
        :items="artistRows"
        :item-height="artistItemHeight"
      >
        <template #default="{ item: row, index }">
          <div class="artist-grid" :style="{ paddingTop: index === 0 ? '0px' : `${artistGap}px` }">
            <artist-card v-for="artist in row" :key="artist.id" :artist="artist" />
          </div>
        </template>
      </v-virtual-scroll>
    </div>

    <v-alert
      v-if="!libraryStore.loading && filteredArtists.length === 0 && !libraryStore.error"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('library.noArtistsForQuery', { query: filterQuery })
          : $t('library.noArtistsFound')
      }}
    </v-alert>

    <infinite-scroll-trigger
      v-if="!virtualizeArtists && visibleCount < filteredArtists.length"
      @trigger="loadMore"
    />

    <alphabet-index-bar
      v-if="!libraryStore.loading && filteredArtists.length > 0"
      :available="availableLetters"
      @select="jumpToLetter"
    />
  </v-container>
</template>

<script lang="ts">
import { ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useElementWidth } from '@/composables/useElementWidth'
import { firstIndexByLetter } from '@/services/alphabetIndex'
import { shuffled } from '@/services/shuffle'
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import AlphabetIndexBar from '@/components/library/AlphabetIndexBar.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Artist } from '@/types/library'

const PAGE_SIZE = 60

// See AlbumsView.vue's ALBUM_VIRTUALIZE_THRESHOLD comment — same reasoning,
// mirrors SongTable.vue's SONG_VIRTUALIZE_THRESHOLD / QueueDrawer.vue's
// QUEUE_VIRTUALIZE_THRESHOLD. Verified elsewhere in this file: 6000+ artists
// is a real library size this app has to handle.
const ARTIST_VIRTUALIZE_THRESHOLD = 500
// Must match .artist-card's own width (ArtistCard.vue) and .artist-grid's
// own gap (below) — turns an available pixel width into a column count.
const ARTIST_ITEM_WIDTH = 160
const ARTIST_GAP = 20
// Seed for v-virtual-scroll's row height (160px cover + mt-2 + name line +
// album-count caption line) — see AlbumsView.vue's identical comment on why
// this doesn't need to be exact.
const ARTIST_ROW_HEIGHT_GUESS = 210

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'ArtistsView',
  components: { DetailHeader, ArtistCard, AlphabetIndexBar, InfiniteScrollTrigger, StickyFilter },
  // Composition API escape hatch just for gridWidth — see
  // AlbumsView.vue's identical setup() and useElementWidth's own comment.
  setup() {
    const gridRoot = ref<HTMLElement | null>(null)
    return { gridRoot, gridWidth: useElementWidth(gridRoot) }
  },
  data() {
    return {
      // getArtists.view has no server-side pagination — it returns the whole
      // library's artist index in one call (verified: 6000+ artists, ~3s to
      // render unbounded). Fetch once, but only ever render a growing slice,
      // same "Mehr laden" pattern as AlbumsView. The filter below runs
      // client-side over everything already loaded, so it's a full-library
      // search despite the paginated rendering.
      visibleCount: PAGE_SIZE,
      filterQuery: '',
      // filteredArtists reads this instead of filterQuery directly — a
      // full-library scan on every keystroke would block the same render
      // pass that's supposed to show the character just typed, making the
      // input itself feel laggy. filterQuery still updates instantly (it's
      // just the input's own text); only the actual filtering waits a beat.
      debouncedQuery: '',
      // Drives the Play Random button's own :loading — playRandomArtist()
      // needs a real fetchArtist() + per-album fetchAlbum() round trip
      // before there's anything to play (see fetchAllSongsForArtist()'s
      // own comment on why a list-view Artist alone isn't enough).
      playingRandomArtist: false,
      // Same, for the "Random from top 20" button below.
      playingTopArtist: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    artistGap() {
      return ARTIST_GAP
    },
    artistItemHeight() {
      return ARTIST_ROW_HEIGHT_GUESS
    },
    filteredArtists(): Artist[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.artists
      return this.libraryStore.artists.filter((artist: Artist) =>
        matchesAllTerms(query, artist.name),
      )
    },
    visibleArtists(): Artist[] {
      return this.filteredArtists.slice(0, this.visibleCount)
    },
    virtualizeArtists(): boolean {
      return this.filteredArtists.length > ARTIST_VIRTUALIZE_THRESHOLD
    },
    columns(): number {
      if (this.gridWidth <= 0) return 1
      return Math.max(
        1,
        Math.floor((this.gridWidth + ARTIST_GAP) / (ARTIST_ITEM_WIDTH + ARTIST_GAP)),
      )
    },
    artistRows(): Artist[][] {
      if (!this.virtualizeArtists) return []
      const cols = this.columns
      const rows: Artist[][] = []
      for (let i = 0; i < this.filteredArtists.length; i += cols) {
        rows.push(this.filteredArtists.slice(i, i + cols))
      }
      return rows
    },
    letterFirstIndex(): Map<string, number> {
      return firstIndexByLetter(this.filteredArtists, (artist) => artist.name)
    },
    availableLetters(): Set<string> {
      return new Set(this.letterFirstIndex.keys())
    },
  },
  watch: {
    filterQuery(value: string | null) {
      this.visibleCount = PAGE_SIZE
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchArtists()
  },
  methods: {
    loadMore() {
      this.visibleCount += PAGE_SIZE
    },
    jumpToLetter(letter: string) {
      const index = this.letterFirstIndex.get(letter)
      if (index === undefined) return
      if (this.virtualizeArtists) {
        const row = Math.floor(index / this.columns)
        const virtualScroll = this.$refs.virtualScroll as
          { scrollToIndex: (i: number) => void } | undefined
        virtualScroll?.scrollToIndex(row)
        return
      }
      // Plain-grid path: see AlbumsView.vue's identical jumpToLetter comment.
      if (index >= this.visibleCount) {
        this.visibleCount = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
      }
      this.$nextTick(() => {
        document
          .querySelector(`[data-artist-index="${index}"]`)
          ?.scrollIntoView({ block: 'center' })
      })
    },
    async playRandomArtist() {
      if (!this.libraryStore.artists.length || this.playingRandomArtist) return
      // Picks from the full unfiltered catalog, same as SongsView's own
      // playRandom() — an active filter narrows what's browsable, not what
      // "random" draws from.
      const artists = this.libraryStore.artists
      const pick = artists[Math.floor(Math.random() * artists.length)]
      if (!pick) return
      this.playingRandomArtist = true
      try {
        await this.playArtistCatalog(pick.id)
      } finally {
        this.playingRandomArtist = false
      }
    },
    async playTopArtist() {
      if (!this.libraryStore.artists.length || this.playingTopArtist) return
      this.playingTopArtist = true
      try {
        // No "top played artists" Subsonic endpoint exists — derived from
        // the artists behind the top played *albums* instead (same
        // server-side frequent-albums source AlbumsView's own
        // playTopAlbum() and HomeView's "Frequently played" shelf use),
        // deduped since more than one of the top albums can share an
        // artist. Not cached — see fetchFrequentAlbums' own comment.
        const topAlbums = await this.libraryStore.fetchFrequentAlbums(20)
        const artistIds = [...new Set(topAlbums.map((album) => album.artistId).filter(Boolean))]
        if (!artistIds.length) return
        const pick = artistIds[Math.floor(Math.random() * artistIds.length)]
        if (!pick) return
        await this.playArtistCatalog(pick)
      } finally {
        this.playingTopArtist = false
      }
    },
    // Shared tail of playRandomArtist()/playTopArtist() — both just pick
    // `artistId` differently, everything after that is identical.
    async playArtistCatalog(artistId: string) {
      // The list-view Artist alone has no real .albums (see
      // fetchAllSongsForArtist()'s own comment) — fetchArtist() first for
      // the full detail fetchAllSongsForArtist() actually needs.
      const full = await this.libraryStore.fetchArtist(artistId)
      const songs = await this.libraryStore.fetchAllSongsForArtist(full)
      if (!songs.length) return
      const playbackStore = usePlaybackStore()
      // Shuffled, unlike AlbumsView's own playRandomAlbum()/playTopAlbum()
      // — an artist's songs span several separately-sequenced albums, so
      // there's no single natural order spanning all of them the way one
      // album's own track order is. pinFirst: false, same reasoning as
      // AlbumCard.vue's onCoverClick().
      // peek: a pick the user didn't make themselves — see
      // peekQueueDrawer()'s own comment for why that opens the drawer.
      await playbackStore.playSongList(shuffled(songs), 0, false, true)
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

/* See AlbumsView.vue's identical .grid-root--with-alphabet-bar comment. */
.grid-root--with-alphabet-bar {
  margin-right: 40px;
}

.artist-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}
</style>
