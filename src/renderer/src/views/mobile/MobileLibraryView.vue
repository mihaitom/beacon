<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('nav.library') }}</h1>
    </div>

    <!-- One list at a time rather than two stacked sections: a phone has
     - room for one, and the search below applies to whichever is showing
     - (see searchLabel). Same shape as the reference implementation in
     - feishin's own remote library page. -->
    <!-- Sticky, the same as RadioView.vue's own filter — this list runs to
     - a whole catalogue, and a switch you have to scroll back up to reach
     - is a switch you stop using. The toggle rides along with it: which
     - half you are searching is part of the search. -->
    <sticky-filter>
      <segmented-control
        :model-value="view"
        :options="viewOptions"
        :label="$t('nav.library')"
        class="mobile-library__toggle"
        @update:model-value="view = $event as 'albums' | 'songs'"
      />
      <v-text-field
        v-model="filterQuery"
        :label="searchLabel"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        hide-details
      />
    </sticky-filter>

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="view-notice" />

    <div class="mobile-library__list">
      <template v-if="showingSongs">
        <mobile-song-row
          v-for="(song, index) in visibleSongs"
          :key="song.id"
          :song="song"
          @play="play(index)"
          @open-actions="openActions(song)"
        />
      </template>
      <template v-else>
        <mobile-album-row
          v-for="album in visibleAlbums"
          :key="album.id"
          :album="album"
          @play="playAlbum(album)"
        />
      </template>
    </div>

    <v-btn
      v-if="hasMore"
      block
      variant="tonal"
      class="mobile-library__more"
      @click="pageSize += PAGE_SIZE"
    >
      {{ $t('common.loadMore') }}
    </v-btn>

    <v-alert v-if="showEmptyState" type="info" variant="tonal">{{ emptyMessage }}</v-alert>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Album, Song } from '@/types/library'

// Rendered as a plain list (no virtualization, unlike desktop's SongTable.vue
// v-virtual-scroll) — simple "load more" paging keeps a 20k+-song catalog
// from ever mounting more rows at once than a phone needs to scroll through,
// same idea the LAN remote's own library view already validated.
const PAGE_SIZE = 50

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobileLibraryView',
  components: {
    MobileSongRow,
    MobileAlbumRow,
    MobileSongActionSheet,
    SegmentedControl,
    StickyFilter,
  },
  data() {
    return {
      PAGE_SIZE,
      view: 'songs' as 'songs' | 'albums',
      filterQuery: '',
      debouncedQuery: '',
      pageSize: PAGE_SIZE,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    showingSongs(): boolean {
      return this.view === 'songs'
    },
    viewOptions() {
      return [
        { title: this.$t('library.songs'), value: 'songs' },
        { title: this.$t('library.albums'), value: 'albums' },
      ]
    },
    searchLabel(): string {
      return this.showingSongs ? this.$t('library.searchSongs') : this.$t('library.searchAlbums')
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.allSongs
      return this.libraryStore.allSongs.filter((song: Song) =>
        matchesAllTerms(query, song.title, song.artist, song.album),
      )
    },
    filteredAlbums(): Album[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.albums
      return this.libraryStore.albums.filter((album: Album) =>
        matchesAllTerms(query, album.name, album.artist),
      )
    },
    visibleSongs(): Song[] {
      return this.filteredSongs.slice(0, this.pageSize)
    },
    visibleAlbums(): Album[] {
      return this.filteredAlbums.slice(0, this.pageSize)
    },
    hasMore(): boolean {
      return this.showingSongs
        ? this.visibleSongs.length < this.filteredSongs.length
        : this.visibleAlbums.length < this.filteredAlbums.length
    },
    showEmptyState(): boolean {
      if (this.libraryStore.loading) return false
      return this.showingSongs ? this.filteredSongs.length === 0 : this.filteredAlbums.length === 0
    },
    emptyMessage(): string {
      const query = this.debouncedQuery
      if (this.showingSongs) {
        return query
          ? this.$t('library.noSongsForQuery', { query })
          : this.$t('library.noSongsFound')
      }
      return query
        ? this.$t('library.noAlbumsForQuery', { query })
        : this.$t('library.noAlbumsFound')
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
        this.pageSize = PAGE_SIZE
      }, 200)
    },
    /** The search deliberately survives the switch: noticing you are in the
     * wrong half is usually what makes you switch in the first place, and
     * having to retype the term you just entered is a penalty for one tap.
     * The field is clearable, which is the cheaper way out for the rarer
     * case of actually wanting a fresh search. Only the paging counter
     * resets, since that is genuinely about the list now showing. */
    view() {
      this.pageSize = PAGE_SIZE
      if (!this.showingSongs) void this.libraryStore.fetchAlbums()
    },
    // Not created() alone: Vue Router reuses this component when only the
    // query changes, so a second hand-over while already here would be
    // silently ignored. Same reason SearchView.vue watches its own.
    '$route.query.q': 'applyHandedOverSearch',
  },
  created() {
    this.libraryStore.fetchAllSongs()
    this.applyHandedOverSearch()
  },
  methods: {
    /** A search term handed over from somewhere else — the radio title
     * log's "find this in my library" (components/radio/RadioTitleLog.vue)
     * is the caller today, which on this layout comes here rather than to
     * the desktop search page.
     *
     * Sets both fields instead of going through the debounce above: that
     * exists so typing doesn't re-filter the whole catalogue per
     * keystroke, and a term that arrives complete has nothing to wait for.
     * Through the debounce it would show the unfiltered library first and
     * only then the result. */
    applyHandedOverSearch() {
      // Optional: this reads a nice-to-have, and the view is perfectly
      // usable mounted without a router at all (its own tests do exactly
      // that) — a hand-over that cannot be read is simply not one.
      const term = this.$route?.query?.q
      if (typeof term !== 'string' || !term) return
      this.filterQuery = term
      this.debouncedQuery = term
      this.pageSize = PAGE_SIZE
    },
    /** The tapped song alone, not the list around it. This list is the
     * whole catalogue, or whatever a search term happened to match - a set
     * of matches rather than a sequence anyone meant to hear in order, so
     * playing one of them must not queue the rest behind it. Same rule as
     * SongsView and the search results on the desktop (SongTable.vue's
     * `queueWholeList`), and as this view's own action sheet, whose Play
     * already did exactly this - tapping the row and picking Play from the
     * "..." menu were two different actions until now. */
    async play(index: number) {
      const song = this.visibleSongs[index]
      if (!song) return
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

.mobile-library__list {
  display: flex;
  flex-direction: column;
}

/* The "load more" button, set off from the last row above it. */
.mobile-library__more {
  margin-top: 12px;
}
</style>
