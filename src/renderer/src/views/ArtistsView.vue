<template>
  <v-container fluid>
    <detail-header :title="$t('library.artists')" stored-fanart>
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
      <div class="library-filter">
        <v-text-field
          v-model="filterQuery"
          :label="$t('search.label')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          clearable
          class="library-search"
        />
        <exact-match-switch />
      </div>
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="view-notice">
      {{ libraryStore.error }}
    </v-alert>
    <v-progress-circular v-if="libraryStore.loading" indeterminate class="view-notice" />

    <div
      ref="gridRoot"
      :class="{
        'grid-root--with-alphabet-bar': !libraryStore.loading && filteredArtists.length > 0,
      }"
    >
      <div v-if="!virtualizeArtists" class="artist-grid">
        <template v-for="(artist, index) in visibleArtists" :key="artist.id">
          <!-- A full-width divider before each letter's first card - see
           - .letter-divider's own comment for why it forces a line break. -->
          <div v-if="startsLetterSection(index)" class="letter-divider" aria-hidden="true">
            <span class="letter-divider__label">{{ letterAt(index) }}</span>
          </div>
          <artist-card :data-artist-index="index" :artist="artist" />
        </template>
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
            <!-- One row is never allowed to span two letters (see artistRows),
             - so the divider sits at the top of a row and the cards below it
             - fill that row completely. data-artist-index is the card's own
             - position in the whole list, which is what the A-Z highlight
             - reads (see observeActiveLetter). -->
            <div
              v-if="startsLetterSection(row.startIndex)"
              class="letter-divider"
              aria-hidden="true"
            >
              <span class="letter-divider__label">{{ letterAt(row.startIndex) }}</span>
            </div>
            <artist-card
              v-for="(artist, column) in row.items"
              :key="artist.id"
              :data-artist-index="row.startIndex + column"
              :artist="artist"
            />
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
      :active="activeLetter"
      @select="jumpToLetter"
    />
  </v-container>
</template>

<script lang="ts">
import { ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useElementWidth } from '@/composables/useElementWidth'
import { firstIndexByLetter, indexLetterFor } from '@/services/alphabetIndex'
import { observeActiveLetter, type ActiveLetterHandle } from '@/services/activeLetter'
import { shuffled } from '@/services/shuffle'
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import AlphabetIndexBar from '@/components/library/AlphabetIndexBar.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
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

/** One v-virtual-scroll item: a row of cards that never spans two letters,
 * so its divider can sit at the top and the cards below fill the row.
 * `startIndex` is the row's first card's position in the whole list, which
 * the template needs for data-artist-index and the divider's own label. */
interface ArtistRow {
  items: Artist[]
  startIndex: number
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'ArtistsView',
  components: {
    DetailHeader,
    ArtistCard,
    AlphabetIndexBar,
    InfiniteScrollTrigger,
    StickyFilter,
    ExactMatchSwitch,
  },
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
      // Which letter's section is on screen, for AlphabetIndexBar's "you
      // are here" highlight — see observeActiveLetter.
      activeLetter: null as string | null,
      activeLetterObserver: null as ActiveLetterHandle | null,
    }
  },
  mounted() {
    this.activeLetterObserver = observeActiveLetter({
      itemSelector: '[data-artist-index]',
      readIndex: (item) => {
        const value = item.getAttribute('data-artist-index')
        return value === null ? null : Number(value)
      },
      letterFirstIndex: () => this.letterFirstIndex,
      onChange: (letter) => {
        this.activeLetter = letter
      },
    })
  },
  beforeUnmount() {
    this.activeLetterObserver?.stop()
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
        matchesAllTerms(query, [artist.name], { exact: this.libraryStore.searchExact }),
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
    artistRows(): ArtistRow[] {
      if (!this.virtualizeArtists) return []
      const cols = this.columns
      const letters = this.indexLetters
      const rows: ArtistRow[] = []
      let start = 0
      while (start < this.filteredArtists.length) {
        const letter = letters[start]
        let end = start + 1
        // Fill the row, but never past the end of this letter's run: a row
        // spanning two letters is what left the line half empty and the
        // divider stuck in the middle of a row.
        while (end < this.filteredArtists.length && end - start < cols && letters[end] === letter) {
          end++
        }
        rows.push({ items: this.filteredArtists.slice(start, end), startIndex: start })
        start = end
      }
      return rows
    },
    letterFirstIndex(): Map<string, number> {
      // indexLetterFor prefers the server's sort name — see its own comment
      // on why the display name's first letter can be the wrong section.
      return firstIndexByLetter(this.filteredArtists, indexLetterFor)
    },
    availableLetters(): Set<string> {
      return new Set(this.letterFirstIndex.keys())
    },
    // Each card's own letter, position for position with filteredArtists —
    // what the divider and its label read (see letterAt/startsLetterSection).
    // The reverse of letterFirstIndex, which only knows where each run
    // starts, not which run a given card is in.
    indexLetters(): string[] {
      return this.filteredArtists.map(indexLetterFor)
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
    // The list arriving, or the letters moving under a new filter, changes
    // what is on screen without any scroll to drive the highlight — after
    // the re-render, so the DOM it reads is the new one.
    filteredArtists() {
      this.$nextTick(() => this.activeLetterObserver?.update())
    },
  },
  created() {
    this.libraryStore.fetchArtists()
  },
  methods: {
    loadMore() {
      this.visibleCount += PAGE_SIZE
    },
    letterAt(index: number): string {
      return this.indexLetters[index] ?? ''
    },
    startsLetterSection(index: number): boolean {
      return index === 0 || this.indexLetters[index] !== this.indexLetters[index - 1]
    },
    jumpToLetter(letter: string) {
      const index = this.letterFirstIndex.get(letter)
      if (index === undefined) return
      // Immediate feedback while the jump is still animating; the scroll
      // listener then takes over.
      this.activeLetter = letter
      if (this.virtualizeArtists) {
        const row = this.artistRows.findIndex(
          (candidate) =>
            index >= candidate.startIndex && index < candidate.startIndex + candidate.items.length,
        )
        const virtualScroll = this.$refs.virtualScroll as
          { scrollToIndex: (i: number) => void } | undefined
        // The row's top is the letter's divider. 'start' is what lands the
        // section in the upper half, its divider just below the app bar and
        // filter and its cards under that; centring the row drops the whole
        // section into the lower half instead.
        if (row >= 0) virtualScroll?.scrollToIndex(row)
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
