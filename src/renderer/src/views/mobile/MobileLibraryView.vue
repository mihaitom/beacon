<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">
        {{ favoritesOnly ? $t('nav.favorites') : $t('nav.library') }}
      </h1>
    </div>

    <!-- One list at a time rather than two stacked sections: a phone has
     - room for one. Artists open their own page (MobileArtistDetailView.vue)
     - rather than playing. Searching is the app bar's field
     - (MobileTopBarSearch.vue), as on the desktop; finding a place in a long
     - list is the letter bar's job here. -->
    <!-- Sticky: the list runs to a whole catalogue, and a switch you have to
     - scroll back up to reach is a switch you stop using. -->
    <sticky-filter @resize="stickyHeight = $event">
      <segmented-control
        :model-value="view"
        :options="viewOptions"
        :label="$t('nav.library')"
        class="mobile-library__toggle"
        @update:model-value="view = $event as LibraryTab"
      />
      <!-- The desktop's controls for a library list, in its order - how it is
         - laid out, what it is narrowed to, how it is put in order - with the
         - favourites in front: one tap to them, as the heart in the old
         - search field was. Each half keeps its own. -->
      <div class="mobile-library__controls">
        <v-btn
          v-if="canFilterFavorites"
          :icon="favoritesOnly ? 'mdi-heart' : 'mdi-heart-outline'"
          variant="flat"
          class="mobile-library__favorites"
          :class="{ 'mobile-library__favorites--on': favoritesOnly }"
          :title="$t('library.favoritesOnly')"
          :aria-label="$t('library.favoritesOnly')"
          :aria-pressed="favoritesOnly"
          @click="favoritesOnly = !favoritesOnly"
        />
        <v-btn-toggle
          :model-value="gridOn ? 'grid' : 'list'"
          mandatory
          density="compact"
          class="beacon-view-toggle"
          :aria-label="$t('library.layout')"
          @update:model-value="setGrid($event === 'grid')"
        >
          <v-btn value="grid" icon="mdi-view-grid-outline" :title="$t('library.layoutGrid')" />
          <v-btn value="list" icon="mdi-view-list" :title="$t('library.layoutList')" />
        </v-btn-toggle>
        <library-filter-menu
          icon-only
          :model-value="filters[view]"
          :items="currentItems"
          :fields="currentFilterFields"
          @update:model-value="filters[view] = $event"
        />
        <library-sort-select
          :model-value="currentSort.key"
          :items="sortItems"
          :direction="currentSort.direction"
          class="mobile-library__sort"
          @update:model-value="pickSort"
          @toggle-direction="toggleDirection"
        />
      </div>
    </sticky-filter>

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="view-notice" />

    <!-- The whole catalogue, virtualized: the scroll reaches its end
     - without anything to tap, and only the rows near the screen are
     - mounted - see MobileQueueView's list for what mounting them all did. -->
    <!-- One list for both layouts: a divider before each section, as on
       - the desktop, then rows - one item each as a list, a grid's width of
       - tiles otherwise. Each entry is measured (itemRef), since a divider
       - and a row of tiles are not the height of a list row. -->
    <div class="mobile-library__list">
      <v-virtual-scroll ref="scroller" renderless :items="entries" :item-height="entryHeight">
        <template #default="{ item: entry, index, itemRef }">
          <div
            v-if="entry.kind === 'section'"
            :key="entry.key"
            :ref="itemRef"
            :data-section-index="index"
            class="letter-divider mobile-library__divider"
            aria-hidden="true"
          >
            <span class="letter-divider__label">{{ sectionLabel(entry.section) }}</span>
          </div>
          <div
            v-else-if="gridOn"
            :key="entry.key"
            :ref="itemRef"
            :data-item-index="entry.items[0]!.index"
            class="mobile-library__grid-row"
            :style="{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }"
          >
            <mobile-grid-tile
              v-for="cell in entry.items"
              :key="cell.item.id"
              :kind="tileKind"
              :item="cell.item"
              :song-count="songCountOf(cell.item)"
              :detail="detailOf(cell.item)"
              @play="play(cell.item as Song, cell.index)"
            />
          </div>
          <div
            v-else
            :key="entry.key"
            :ref="itemRef"
            :data-item-index="entry.items[0]!.index"
            class="mobile-library__row"
          >
            <template v-for="cell in entry.items" :key="cell.item.id">
              <mobile-song-row
                v-if="showingSongs"
                :song="cell.item as Song"
                :detail="detailOf(cell.item)"
                @play="play(cell.item as Song, cell.index)"
                @open-actions="openActions(cell.item as Song)"
              />
              <mobile-album-row
                v-else-if="view === 'albums'"
                :album="cell.item as Album"
                :detail="detailOf(cell.item)"
                @play="playAlbum(cell.item as Album)"
              />
              <mobile-artist-row
                v-else
                :artist="cell.item as Artist"
                :detail="detailOf(cell.item)"
              />
            </template>
          </div>
        </template>
      </v-virtual-scroll>
    </div>

    <!-- The desktop's letter bar, made for a thumb: out of sight until the
       - list moves, then a grip on the edge to pull through the sections. -->
    <mobile-section-scrubber
      v-if="showIndexBar"
      :sections="barSections"
      :available="availableSections"
      :label="barLabel"
      :active="activeSection"
      :top-inset="stickyHeight"
      @select="jumpTo"
    />

    <empty-state
      v-if="showEmptyState"
      :icon="emptyIcon"
      :title="emptyMessage"
      :text="favoritesOnly ? $t('favorites.emptyHint') : undefined"
    />

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import { usePlaybackStore } from '@/stores/playback'
import { artistNameKey } from '@/services/artistCredits'
import { readBooleanPreference, writeBooleanPreference } from '@/services/booleanPreference'
import { loadAlbumSort, saveAlbumSort, type AlbumSort } from '@/services/albumSort'
import { loadArtistSort, saveArtistSort, type ArtistSort } from '@/services/artistSort'
import {
  filterSongs,
  loadSongSort,
  saveSongSort,
  type SongSort,
} from '@/services/library/songBrowse'
import type { FilterFieldDef, LibraryFilters } from '@/services/library/libraryFilter'
import {
  barSectionsOf,
  defaultDirectionOf,
  effectiveSort,
  filterFieldsOf,
  filterList,
  sectionLabel as browseSectionLabel,
  sectionOfFn,
  sectionShortLabel,
  sortDetail,
  sortItems as browseSortItems,
  sortKeysOf,
  sortLabelKeyOf,
  type AnySort,
  type BrowseContext,
  type LibraryTab,
} from '@/services/library/libraryBrowse'
import { sectionedRows, type SectionedEntry } from '@/services/library/sectionedRows'
import { observeActiveLetter, type ActiveLetterHandle } from '@/services/activeLetter'
import MobileSectionScrubber from '@/components/mobile/MobileSectionScrubber.vue'
import type { ArtistStatsOf } from '@/services/library/artistStats'
import LibraryFilterMenu from '@/components/library/LibraryFilterMenu.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import MobileGridTile from '@/components/mobile/MobileGridTile.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileArtistRow from '@/components/mobile/MobileArtistRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import type { Album, Artist, Song } from '@/types/library'

/** Tiles at least this wide: two across a phone, more on a tablet. */
const GRID_MIN_TILE = 140
const GRID_GAP = 12
/** v-container's own padding, on each side. */
const GRID_SIDE_PADDING = 16
/** Title and second line under the cover, plus the gap to the next row -
 * only the first guess, each row is measured once it is drawn. */
const GRID_TEXT_HEIGHT = 64

/** Grid or list per half, remembered on this device; apart from the
 * desktop's own choice, which is made for a much wider window. */
const GRID_KEY: Record<LibraryTab, string> = {
  songs: 'beacon.mobileLibraryGrid.songs',
  albums: 'beacon.mobileLibraryGrid.albums',
  artists: 'beacon.mobileLibraryGrid.artists',
}

/** The heart filter outlives the view: the tab bar opens the library at
 * its bare address, and someone who lives in their favourites should find
 * them there again. Not stored, so a reload starts from the whole library -
 * a filter nobody remembers switching on reads as missing music. */
let favoritesOnlyThisSession = false

/** For tests, which mount the view many times in one module. */
export function resetFavoritesFilter(): void {
  favoritesOnlyThisSession = false
}

export default {
  name: 'MobileLibraryView',
  components: {
    EmptyState,
    MobileSectionScrubber,
    MobileSongRow,
    MobileAlbumRow,
    MobileArtistRow,
    MobileSongActionSheet,
    MobileGridTile,
    LibraryFilterMenu,
    LibrarySortSelect,
    SegmentedControl,
    StickyFilter,
  },
  data() {
    return {
      MOBILE_ROW_HEIGHT,
      view: 'songs' as LibraryTab,
      favoritesOnly: favoritesOnlyThisSession,
      actionsOpen: false,
      activeSong: null as Song | null,
      // The desktop's own remembered orders: the same library, browsed the
      // same way on either screen.
      songSort: loadSongSort(),
      albumSort: loadAlbumSort(),
      artistSort: loadArtistSort(),
      filters: { songs: {}, albums: {}, artists: {} } as Record<LibraryTab, LibraryFilters>,
      grid: {
        songs: readBooleanPreference(GRID_KEY.songs),
        albums: readBooleanPreference(GRID_KEY.albums),
        artists: readBooleanPreference(GRID_KEY.artists),
      } as Record<LibraryTab, boolean>,
      gridWidth: window.innerWidth,
      stickyHeight: 0,
      activeSection: null as string | null,
      activeSectionObserver: null as ActiveLetterHandle | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    canFilterFavorites(): boolean {
      return useAuthStore().capabilities.favorites
    },
    songs(): Song[] {
      return this.favoritesOnly ? this.libraryStore.starred.songs : this.libraryStore.allSongs
    },
    albums(): Album[] {
      return this.favoritesOnly ? this.libraryStore.starred.albums : this.libraryStore.albums
    },
    artists(): Artist[] {
      return this.favoritesOnly ? this.libraryStore.starred.artists : this.libraryStore.artists
    },
    showingSongs(): boolean {
      return this.view === 'songs'
    },
    authStore() {
      return useAuthStore()
    },
    rated(): boolean {
      return this.authStore.capabilities.personalRating
    },
    /** The figures counted out of the song catalogue, for the artist orders
     * and filters that need them - nothing until it has arrived, the same
     * as ArtistsView.vue. */
    statsOf(): ArtistStatsOf {
      const store = this.libraryStore
      if (!store.allSongsLoaded) return () => null
      const stats = store.artistStatsByName
      return (artist) => stats.get(artistNameKey(artist.name)) ?? null
    },
    browseContext(): BrowseContext {
      return {
        serverType: this.authStore.serverType,
        rated: this.rated,
        favorites: this.authStore.capabilities.favorites,
        statsOf: this.statsOf,
      }
    },
    currentFilterFields(): FilterFieldDef<never>[] {
      return filterFieldsOf(this.view, this.browseContext)
    },
    /** The whole half, for the filter menu's counts. */
    currentItems(): unknown[] {
      if (this.view === 'artists') return this.artists
      return this.view === 'albums' ? this.albums : this.songs
    },
    sortItems(): { title: string; value: string }[] {
      return sortKeysOf(this.view, this.browseContext).map((key) => ({
        title: this.$t(sortLabelKeyOf(this.view, key)),
        value: key,
      }))
    },
    currentSort(): AnySort {
      return this.currentSortFor(this.view)
    },
    gridOn(): boolean {
      return this.grid[this.view]
    },
    /** The scrubber only shows while the list moves, and over it - so the
     * list keeps its whole width. */
    listWidth(): number {
      return this.gridWidth - 2 * GRID_SIDE_PADDING
    },
    gridColumns(): number {
      const room = this.listWidth + GRID_GAP
      return Math.max(2, Math.floor(room / (GRID_MIN_TILE + GRID_GAP)))
    },
    entryHeight(): number {
      if (!this.gridOn) return MOBILE_ROW_HEIGHT
      const tile = (this.listWidth - GRID_GAP * (this.gridColumns - 1)) / this.gridColumns
      return Math.round(tile + GRID_TEXT_HEIGHT)
    },
    tileKind(): 'song' | 'album' | 'artist' {
      if (this.view === 'artists') return 'artist'
      return this.view === 'albums' ? 'album' : 'song'
    },
    /** Which section an item sits in under the current order, or null for
     * an order without sections - the desktop's own rules, per half. */
    sectionOf(): ((item: Song | Album | Artist) => string) | null {
      return sectionOfFn(this.view, this.currentSort, this.browseContext)
    },
    shownList(): (Song | Album | Artist)[] {
      if (this.view === 'artists') return this.filteredArtists
      return this.view === 'albums' ? this.filteredAlbums : this.filteredSongs
    },
    entries(): SectionedEntry<Song | Album | Artist>[] {
      const perRow = this.gridOn ? this.gridColumns : 1
      return sectionedRows(this.shownList, this.sectionOf, perRow, (item) => item.id)
    },
    /** Every section the bar lists for this order, whole or as far as the
     * library reaches - the desktop's own sets, from the unfiltered list so
     * the bar keeps its shape while a filter greys parts of it out. */
    barSections(): string[] {
      const sorted =
        this.view === 'artists'
          ? this.sortedArtists
          : this.view === 'albums'
            ? this.sortedAlbums
            : this.sortedSongs
      return barSectionsOf(this.view, sorted, this.currentSort, this.browseContext)
    },
    availableSections(): Set<string> {
      return new Set(this.sectionEntryIndex.keys())
    },
    /** Where each section's divider sits among the entries, for a jump. */
    sectionEntryIndex(): Map<string, number> {
      const map = new Map<string, number>()
      this.entries.forEach((entry, index) => {
        if (entry.kind === 'section' && !map.has(entry.section)) map.set(entry.section, index)
      })
      return map
    },
    /** Each section's first item, for the "you are here" highlight. */
    sectionFirstItem(): Map<string, number> {
      const map = new Map<string, number>()
      this.entries.forEach((entry, index) => {
        const next = this.entries[index + 1]
        if (entry.kind === 'section' && next?.kind === 'row' && !map.has(entry.section)) {
          map.set(entry.section, next.items[0]!.index)
        }
      })
      return map
    },
    showIndexBar(): boolean {
      return this.barSections.length > 1 && this.shownList.length > 0
    },
    viewOptions() {
      return [
        { title: this.$t('library.songs'), value: 'songs' },
        { title: this.$t('library.albums'), value: 'albums' },
        { title: this.$t('library.artists'), value: 'artists' },
      ]
    },
    sortedSongs(): Song[] {
      return browseSortItems(
        'songs',
        this.songs,
        this.currentSortFor('songs'),
        this.browseContext,
      ) as Song[]
    },
    sortedAlbums(): Album[] {
      return browseSortItems(
        'albums',
        this.albums,
        this.currentSortFor('albums'),
        this.browseContext,
      ) as Album[]
    },
    sortedArtists(): Artist[] {
      return browseSortItems(
        'artists',
        this.artists,
        this.currentSortFor('artists'),
        this.browseContext,
      ) as Artist[]
    },
    filteredSongs(): Song[] {
      return filterSongs(this.sortedSongs, this.filters.songs)
    },
    filteredAlbums(): Album[] {
      return filterList(
        'albums',
        this.sortedAlbums,
        this.filters.albums,
        this.browseContext,
      ) as Album[]
    },
    filteredArtists(): Artist[] {
      return filterList(
        'artists',
        this.sortedArtists,
        this.filters.artists,
        this.browseContext,
      ) as Artist[]
    },
    showEmptyState(): boolean {
      if (this.libraryStore.loading) return false
      if (this.view === 'artists') return this.filteredArtists.length === 0
      return this.showingSongs ? this.filteredSongs.length === 0 : this.filteredAlbums.length === 0
    },
    emptyIcon(): string {
      return this.favoritesOnly ? 'mdi-heart-outline' : 'mdi-music-note-off'
    },
    emptyMessage(): string {
      if (this.favoritesOnly) {
        if (this.view === 'artists') return this.$t('favorites.noArtistsYet')
        return this.showingSongs
          ? this.$t('favorites.noSongsYet')
          : this.$t('favorites.noAlbumsYet')
      }
      if (this.view === 'artists') return this.$t('library.noArtistsFound')
      return this.showingSongs ? this.$t('library.noSongsFound') : this.$t('library.noAlbumsFound')
    },
  },
  watch: {
    view(view: LibraryTab) {
      if (view === 'albums') void this.libraryStore.fetchAlbums()
      if (view === 'artists') void this.libraryStore.fetchArtists()
      this.activeSection = null
      this.rememberPlace()
    },
    // What is on screen moves without a scroll to say so.
    entries() {
      this.$nextTick(() => this.activeSectionObserver?.update())
    },
    // Immediate for the fetch only: the address is written once created()
    // has read the one it arrived with, or this would overwrite it first.
    favoritesOnly: {
      immediate: true,
      handler(on: boolean, previous: boolean | undefined) {
        favoritesOnlyThisSession = on
        if (on) void this.libraryStore.fetchStarred()
        if (previous !== undefined) this.rememberPlace()
      },
    },
    // A server without favourites never shows the heart, so nor may it be
    // left filtering by one switched on elsewhere.
    canFilterFavorites: {
      immediate: true,
      handler(can: boolean) {
        if (!can) this.favoritesOnly = false
      },
    },
  },
  mounted() {
    window.addEventListener('resize', this.measureGrid)
    this.activeSectionObserver = observeActiveLetter({
      itemSelector: '[data-item-index]',
      readIndex: (element) => {
        const index = Number((element as HTMLElement).dataset.itemIndex)
        return Number.isFinite(index) ? index : null
      },
      letterFirstIndex: () => this.sectionFirstItem,
      onChange: (section) => {
        this.activeSection = section
      },
    })
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.measureGrid)
    this.activeSectionObserver?.stop()
  },
  created() {
    this.libraryStore.fetchAllSongs()
    this.applyAddress()
    // A filter kept from earlier in the session goes into the address too.
    if (this.favoritesOnly) this.rememberPlace()
  },
  methods: {
    /** The half and the heart from the address - where rememberPlace()
     * left them, or a link (the old favourites one) put them. Optional: the
     * view is usable mounted without a router at all, as its tests do. */
    applyAddress() {
      const tab = this.$route?.query?.tab
      if (tab === 'albums' || tab === 'songs' || tab === 'artists') this.view = tab
      if (this.$route?.query?.favorites) this.favoritesOnly = true
    },
    /** Puts the half being browsed and the heart in the address, so coming
     * back from an album finds them still there - this view is unmounted
     * while the album is open. replace(), not push(): a switch of half is
     * not a step anyone means to walk back through. */
    rememberPlace() {
      if (!this.$router || !this.$route) return
      const query: Record<string, string> = {}
      for (const [key, value] of Object.entries(this.$route.query)) {
        if (typeof value === 'string') query[key] = value
      }
      if (this.view === 'songs') delete query.tab
      else query.tab = this.view
      if (this.favoritesOnly) query.favorites = '1'
      else delete query.favorites
      if (query.tab === this.$route.query.tab && query.favorites === this.$route.query.favorites) {
        return
      }
      void this.$router.replace({ query })
    },
    /** The tapped song alone, not the list around it. This list is the
     * whole catalogue - not a sequence anyone meant to hear in order, so
     * playing one of it must not queue the rest behind it. Same rule as
     * SongsView and the search results on the desktop (SongTable.vue's
     * `queueWholeList`), and as this view's own action sheet, whose Play
     * already did exactly this - tapping the row and picking Play from the
     * "..." menu were two different actions until now. */
    async play(song: Song, index: number) {
      if (this.favoritesOnly) {
        // Favourites are the exception: a collection somebody put
        // together, which plays on after the tapped song - the desktop
        // Favourites page reads them the same way.
        const songs = this.filteredSongs
        await usePlaybackStore().playSongList(songs, index, true, songs.length > 1)
        return
      }
      await usePlaybackStore().playSongList([song], 0)
    },
    /** Natural track order, not shuffled, and pinFirst false — an album is
     * a deliberately-sequenced work rather than a pile of songs. Same call
     * AlbumsView.vue makes on the desktop; peeks the queue drawer because
     * what lands in it is the server's track order, not a pick the user
     * made row by row. */
    async playAlbum(album: Album) {
      const full = await this.libraryStore.fetchAlbum(album.id)
      await usePlaybackStore().playSongList(full.songs, 0, false, true)
    },
    currentSortFor(view: LibraryTab): AnySort {
      const sort: AnySort =
        view === 'artists' ? this.artistSort : view === 'albums' ? this.albumSort : this.songSort
      return effectiveSort(view, sort, this.browseContext)
    },
    pickSort(key: string) {
      this.setSort({ key, direction: defaultDirectionOf(this.view, key) })
    },
    toggleDirection() {
      const { key, direction } = this.currentSort
      this.setSort({ key, direction: direction === 'asc' ? 'desc' : 'asc' })
    },
    setSort(sort: AnySort) {
      if (this.view === 'artists') {
        this.artistSort = sort as ArtistSort
        saveArtistSort(this.artistSort)
      } else if (this.view === 'albums') {
        this.albumSort = sort as AlbumSort
        saveAlbumSort(this.albumSort)
      } else {
        this.songSort = sort as SongSort
        saveSongSort(this.songSort)
      }
    },
    setGrid(on: boolean) {
      this.grid[this.view] = on
      writeBooleanPreference(GRID_KEY[this.view], on)
    },
    sectionLabel(section: string): string {
      return browseSectionLabel(this.view, this.currentSort.key, section, this.$t)
    },
    /** What the list is sorted by, on the item's second line. */
    detailOf(item: Song | Album | Artist): string | null {
      return sortDetail(
        this.view,
        this.currentSort.key,
        item,
        {
          t: this.$t,
          plural: (key, count) => this.$t(key, { n: this.$n(count) }, count),
          locale: this.$i18n.locale,
        },
        this.browseContext,
      )
    },
    songCountOf(item: Song | Album | Artist): number | null {
      if (this.view !== 'artists') return null
      return this.statsOf(item as Artist)?.songCount ?? null
    },
    barLabel(section: string): string {
      return sectionShortLabel(this.view, this.currentSort.key, section, this.$t)
    },
    /** Onto the section's divider, clear of the sticky controls above the
     * list - the scroller lands its target at the very top of the pane,
     * which is where they sit. */
    jumpTo(section: string) {
      const index = this.sectionEntryIndex.get(section)
      if (index === undefined) return
      this.activeSection = section
      const scroller = this.$refs.scroller as { scrollToIndex?: (i: number) => void } | undefined
      scroller?.scrollToIndex?.(index)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const pane = document.querySelector('.v-main')
          const divider = pane?.querySelector<HTMLElement>(`[data-section-index="${index}"]`)
          if (!pane || !divider) return
          // The pane runs under the app bar, which it keeps clear as padding.
          const contentTop =
            pane.getBoundingClientRect().top + (parseFloat(getComputedStyle(pane).paddingTop) || 0)
          const offset = divider.getBoundingClientRect().top - contentTop
          pane.scrollTop += offset - this.stickyHeight
        }),
      )
    },
    measureGrid() {
      this.gridWidth = window.innerWidth
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-library__toggle {
  margin-bottom: 12px;
}

/* The filter button's pill (LibraryFilterMenu.vue) and, once on, the amber
 * an active filter gets: the heart is the quickest filter of them. */
.mobile-library__favorites.v-btn {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.mobile-library__favorites--on.v-btn {
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.14);
}

.mobile-library__list {
  display: flex;
  flex-direction: column;
}

.mobile-library__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.mobile-library__sort {
  flex: 1;
  min-width: 0;
}

.mobile-library__grid-row {
  display: grid;
  gap: 0 12px;
  padding-bottom: 16px;
}

/* The desktop list's divider spacing (SongTable.vue's .song-section), a
 * little tighter at the side to sit on the rows' own edge. */
.mobile-library__divider {
  padding: 16px 4px 6px;
}
</style>
