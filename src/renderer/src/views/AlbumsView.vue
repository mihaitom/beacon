<template>
  <v-container fluid>
    <detail-header :title="$t('library.albums')">
      <template v-if="filteredAlbums.length" #meta>
        {{ filteredAlbums.length }}
        {{ filteredAlbums.length === 1 ? $t('library.album1') : $t('library.albumsN') }}
      </template>
      <!-- Wrapped, not two bare siblings — DetailHeader.vue's own
       - .detail-header__actions only ever had margin-top before (every
       - prior consumer put exactly one button in this slot), no gap/wrap
       - for two v-btns sitting side by side. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-shuffle-variant"
            :loading="playingRandomAlbum"
            :disabled="!libraryStore.albums.length"
            @click="playRandomAlbum"
          >
            {{ $t('library.playRandom') }}
          </v-btn>
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-trending-up"
            :loading="playingTopAlbum"
            :disabled="!libraryStore.albums.length"
            @click="playTopAlbum"
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

    <div
      ref="gridRoot"
      :class="{
        'grid-root--with-alphabet-bar': !libraryStore.loading && filteredAlbums.length > 0,
      }"
    >
      <div v-if="libraryStore.loading" class="album-grid">
        <div v-for="n in skeletonCount" :key="n" class="album-card">
          <v-skeleton-loader
            type="image"
            width="160"
            height="160"
            class="rounded album-card-cover"
          />
          <v-skeleton-loader type="text" width="70%" height="20" class="album-skeleton__label" />
          <v-skeleton-loader type="text" width="45%" height="16" />
        </div>
      </div>
      <div v-else-if="!virtualizeAlbums" class="album-grid">
        <template v-for="(album, index) in visibleAlbums" :key="album.id">
          <!-- A full-width divider before each letter's first card - see
           - .letter-divider's own comment for why it forces a line break. -->
          <div v-if="startsLetterSection(index)" class="letter-divider" aria-hidden="true">
            <span class="letter-divider__label">{{ letterAt(index) }}</span>
          </div>
          <album-card :data-album-index="index" :album="album" />
        </template>
      </div>
      <!-- Past ALBUM_VIRTUALIZE_THRESHOLD, chunk the (already fully-loaded)
       - catalog into fixed-size rows and hand those to v-virtual-scroll
       - instead of growing a flex-wrap grid indefinitely — same reasoning as
       - SongTable.vue's own virtualizeSongs (see its comment): mounting
       - every card at once is the pattern that's frozen/crashed the
       - renderer elsewhere in this app once a list ran into the thousands.
       - renderless + row-chunked because v-virtual-scroll only virtualizes
       - along one axis — each "item" here is one full row of `columns`
       - cards, not one card, so wrapping still happens, just a row at a
       - time instead of the whole grid. paddingTop (not gap or
       - margin-top) supplies the vertical gap between rows: it's the one
       - spacing method that lands inside the element's own measured
       - border-box, which is what v-virtual-scroll's per-item
       - ResizeObserver uses to correct row offsets after the first paint —
       - margin sits outside that box and would silently throw the
       - cumulative offsets off the more rows scroll past. -->
      <v-virtual-scroll
        v-else
        ref="virtualScroll"
        renderless
        :items="albumRows"
        :item-height="albumItemHeight"
      >
        <template #default="{ item: row, index }">
          <div class="album-grid" :style="{ paddingTop: index === 0 ? '0px' : `${albumGap}px` }">
            <!-- One row is never allowed to span two letters (see albumRows),
             - so the divider sits at the top of a row and the cards below it
             - fill that row completely. data-album-index is the card's own
             - position in the whole list, which is what the A-Z highlight
             - reads (see observeActiveLetter). -->
            <div
              v-if="startsLetterSection(row.startIndex)"
              class="letter-divider"
              aria-hidden="true"
            >
              <span class="letter-divider__label">{{ letterAt(row.startIndex) }}</span>
            </div>
            <album-card
              v-for="(album, column) in row.items"
              :key="album.id"
              :data-album-index="row.startIndex + column"
              :album="album"
            />
          </div>
        </template>
      </v-virtual-scroll>
    </div>

    <v-alert
      v-if="!libraryStore.loading && filteredAlbums.length === 0 && !libraryStore.error"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('library.noAlbumsForQuery', { query: filterQuery })
          : $t('library.noAlbumsFound')
      }}
    </v-alert>

    <infinite-scroll-trigger
      v-if="!virtualizeAlbums && visibleCount < filteredAlbums.length"
      @trigger="loadMore"
    />

    <alphabet-index-bar
      v-if="!libraryStore.loading && filteredAlbums.length > 0"
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
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import AlphabetIndexBar from '@/components/library/AlphabetIndexBar.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
import { cardsAcross, observeCardsAcross } from '@/components/library/cardRowFit'
import { observeActiveLetter, type ActiveLetterHandle } from '@/services/activeLetter'
import type { Album } from '@/types/library'

const PAGE_SIZE = 60
// How many rows of placeholder cards to draw. There's no real count to key
// off yet (unlike SongTable's skeleton, which caps at however many rows are
// actually about to load), so this is "enough to read as a grid" — how many
// fit *across* is measured rather than guessed, see cardRowFit.ts, which is
// what keeps this in step with the shelves on Home.
const SKELETON_ROWS = 3

// See the v-virtual-scroll template comment for why this exists — mirrors
// SongTable.vue's SONG_VIRTUALIZE_THRESHOLD / QueueDrawer.vue's
// QUEUE_VIRTUALIZE_THRESHOLD.
const ALBUM_VIRTUALIZE_THRESHOLD = 500
// Must match .album-card's own width (below) and .album-grid's own gap —
// this is what turns an available pixel width into a column count. Same
// pair of values as ArtistsView.vue's and AlbumShelf.vue's: all three lay
// out the same 160px cards, and this grid showing the very same AlbumCards
// at a different spacing than the shelves was an oversight, not a design
// choice. Changing one of the two here without the other silently
// mis-counts columns rather than looking wrong.
const ALBUM_ITEM_WIDTH = 160
const ALBUM_GAP = 20
// Seed for v-virtual-scroll's row height (160px cover + mt-2 + title line +
// artist line) — doesn't need to be exact, just close enough that the
// scrollbar doesn't visibly jump once real rows are measured; see
// VVirtualScroll's own per-item ResizeObserver, which corrects it after
// first paint the same way SongTable.vue's static "48" does.
const ALBUM_ROW_HEIGHT_GUESS = 210

/** One v-virtual-scroll item: a row of cards that never spans two letters,
 * so its divider can sit at the top and the cards below fill the row.
 * `startIndex` is the row's first card's position in the whole list, which
 * the template needs for data-album-index and the divider's own label. */
interface AlbumRow {
  items: Album[]
  startIndex: number
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'AlbumsView',
  components: {
    DetailHeader,
    AlbumCard,
    AlphabetIndexBar,
    InfiniteScrollTrigger,
    StickyFilter,
    ExactMatchSwitch,
  },
  // Composition API escape hatch just for gridWidth (see useElementWidth's
  // own comment) — everything else stays Options API, same idiom as
  // App.vue's identical use of useIsMobileWeb.
  setup() {
    const gridRoot = ref<HTMLElement | null>(null)
    return { gridRoot, gridWidth: useElementWidth(gridRoot) }
  },
  data() {
    return {
      // fetchAlbums() loads the whole catalog in one (cached) go — same
      // "load once, render a growing slice" pattern as ArtistsView. The
      // filter below runs client-side over everything already loaded.
      visibleCount: PAGE_SIZE,
      filterQuery: '',
      // filteredAlbums reads this instead of filterQuery directly — see
      // ArtistsView's identical debounce for why (avoids the freshly-typed
      // character sharing a render pass with a full-list re-filter).
      debouncedQuery: '',
      // Drives the Play Random button's own :loading — fetchAlbum() (for
      // the picked album's actual song list, not yet in libraryStore.albums'
      // summary form) is a real network round trip.
      playingRandomAlbum: false,
      // Same, for the "Random from top 20" button below.
      playingTopAlbum: false,
      // How many cards fit across the grid, measured on mount and kept up
      // to date — 6 until then, which is what a narrow window holds.
      cardsPerRow: 6,
      resizeObserver: null as ResizeObserver | null,
      // Which letter's section is on screen, for AlphabetIndexBar's "you
      // are here" highlight — see observeActiveLetter.
      activeLetter: null as string | null,
      activeLetterObserver: null as ActiveLetterHandle | null,
    }
  },
  mounted() {
    this.resizeObserver = observeCardsAcross(this.$el as Element, (width) => {
      this.cardsPerRow = cardsAcross(width)
    })
    this.activeLetterObserver = observeActiveLetter({
      itemSelector: '[data-album-index]',
      readIndex: (item) => {
        const value = item.getAttribute('data-album-index')
        return value === null ? null : Number(value)
      },
      letterFirstIndex: () => this.letterFirstIndex,
      onChange: (letter) => {
        this.activeLetter = letter
      },
    })
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
    this.activeLetterObserver?.stop()
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    skeletonCount(): number {
      return this.cardsPerRow * SKELETON_ROWS
    },
    albumGap() {
      return ALBUM_GAP
    },
    albumItemHeight() {
      return ALBUM_ROW_HEIGHT_GUESS
    },
    filteredAlbums(): Album[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.albums
      return this.libraryStore.albums.filter((album: Album) =>
        matchesAllTerms(query, [album.name], { exact: this.libraryStore.searchExact }),
      )
    },
    visibleAlbums(): Album[] {
      return this.filteredAlbums.slice(0, this.visibleCount)
    },
    virtualizeAlbums(): boolean {
      return this.filteredAlbums.length > ALBUM_VIRTUALIZE_THRESHOLD
    },
    // Falls back to 1 before the ResizeObserver's first callback (gridWidth
    // still 0) — matters only for that first frame, corrects itself as soon
    // as the real width is measured.
    columns(): number {
      if (this.gridWidth <= 0) return 1
      return Math.max(1, Math.floor((this.gridWidth + ALBUM_GAP) / (ALBUM_ITEM_WIDTH + ALBUM_GAP)))
    },
    albumRows(): AlbumRow[] {
      if (!this.virtualizeAlbums) return []
      const cols = this.columns
      const letters = this.indexLetters
      const rows: AlbumRow[] = []
      let start = 0
      while (start < this.filteredAlbums.length) {
        const letter = letters[start]
        let end = start + 1
        // Fill the row, but never past the end of this letter's run: a row
        // spanning two letters is what left the line half empty and the
        // divider stuck in the middle of a row.
        while (end < this.filteredAlbums.length && end - start < cols && letters[end] === letter) {
          end++
        }
        rows.push({ items: this.filteredAlbums.slice(start, end), startIndex: start })
        start = end
      }
      return rows
    },
    letterFirstIndex(): Map<string, number> {
      // indexLetterFor prefers the server's sort name — see its own comment
      // on why the display name's first letter can be the wrong section.
      return firstIndexByLetter(this.filteredAlbums, indexLetterFor)
    },
    availableLetters(): Set<string> {
      return new Set(this.letterFirstIndex.keys())
    },
    // Each card's own letter, position for position with filteredAlbums —
    // what the divider and its label read (see letterAt/startsLetterSection).
    // The reverse of letterFirstIndex, which only knows where each run
    // starts, not which run a given card is in.
    indexLetters(): string[] {
      return this.filteredAlbums.map(indexLetterFor)
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
    filteredAlbums() {
      this.$nextTick(() => this.activeLetterObserver?.update())
    },
  },
  created() {
    this.libraryStore.fetchAlbums()
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
      if (this.virtualizeAlbums) {
        const row = this.albumRows.findIndex(
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
      // Plain-grid path: make sure the target card is actually rendered
      // before trying to scroll to it — jumping to a letter past
      // visibleCount's current slice would otherwise reach for a card
      // that doesn't exist in the DOM yet.
      if (index >= this.visibleCount) {
        this.visibleCount = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
      }
      this.$nextTick(() => {
        document.querySelector(`[data-album-index="${index}"]`)?.scrollIntoView({ block: 'center' })
      })
    },
    async playRandomAlbum() {
      if (!this.libraryStore.albums.length || this.playingRandomAlbum) return
      // Picks from the full unfiltered catalog, same as SongsView's own
      // playRandom() — an active filter narrows what's browsable, not what
      // "random" draws from.
      const albums = this.libraryStore.albums
      const pick = albums[Math.floor(Math.random() * albums.length)]
      if (!pick) return
      this.playingRandomAlbum = true
      try {
        const full = await this.libraryStore.fetchAlbum(pick.id)
        const playbackStore = usePlaybackStore()
        // pinFirst: false — see AlbumCard.vue's identical onCoverClick()
        // comment. Natural track order, not shuffled: an album is a
        // coherent, deliberately-sequenced work, unlike a pile of
        // unrelated songs.
        // peek: a pick the user didn't make themselves — see
        // peekQueueDrawer()'s own comment for why that opens the drawer.
        await playbackStore.playSongList(full.songs, 0, false, true)
      } finally {
        this.playingRandomAlbum = false
      }
    },
    async playTopAlbum() {
      if (!this.libraryStore.albums.length || this.playingTopAlbum) return
      this.playingTopAlbum = true
      try {
        // getAlbumList2('frequent', ...) — server-side playCount-sorted,
        // same source HomeView's own "Frequently played" shelf uses. Not
        // cached (see fetchFrequentAlbums' own comment): a top-20 that
        // never moves would make this button pick from the same 20 forever
        // even as actual listening habits shift.
        const topAlbums = await this.libraryStore.fetchFrequentAlbums(20)
        if (!topAlbums.length) return
        const pick = topAlbums[Math.floor(Math.random() * topAlbums.length)]
        if (!pick) return
        const full = await this.libraryStore.fetchAlbum(pick.id)
        const playbackStore = usePlaybackStore()
        // pinFirst: false, natural track order — see playRandomAlbum()'s
        // identical comment.
        await playbackStore.playSongList(full.songs, 0, false, true)
      } finally {
        this.playingTopAlbum = false
      }
    },
  },
}
</script>

<style scoped>
/* See this file's own #actions template comment for why this exists. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* Keeps the grid's own rightmost column clear of AlphabetIndexBar's fixed
 * position (right: 6px + its own ~26px width, see its stylesheet) — only
 * applied while the bar actually renders. Shrinks gridRoot's own measured
 * width too (useElementWidth observes this same element), so `columns`
 * accounts for the narrower space automatically. */
.grid-root--with-alphabet-bar {
  margin-right: 40px;
}

.album-grid {
  display: flex;
  flex-wrap: wrap;
  /* Keep in step with ALBUM_GAP in <script>, and with ArtistsView's
   * .artist-grid / AlbumShelf's own row — see ALBUM_GAP's comment. */
  gap: 20px;
}

.album-card {
  width: 160px;
}

/* v-skeleton-loader's width/height props only size the outer wrapper, not
 * the bone itself (see the identical comment/technique in SongTable.vue) —
 * forcing the bone to fill that wrapper is what makes each skeleton card
 * match AlbumCard.vue's real 160x160 cover + two text lines exactly, so
 * nothing shifts once real cards render in. */
.album-card :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

/* Stands in for AlbumCard.vue's own title, which carries the same gap
 * above it — so the placeholder grid is exactly as tall as the real one. */
.album-skeleton__label {
  margin-top: 8px;
}
</style>
