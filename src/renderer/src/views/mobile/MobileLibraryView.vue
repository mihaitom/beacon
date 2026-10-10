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

    <!-- The whole catalogue, virtualized: the scroll reaches its end
     - without anything to tap, and only the rows near the screen are
     - mounted - see MobileQueueView's list for what mounting them all did. -->
    <div class="mobile-library__list">
      <v-virtual-scroll
        v-if="showingSongs"
        renderless
        :items="filteredSongs"
        :item-height="MOBILE_ROW_HEIGHT"
      >
        <template #default="{ item: song }">
          <mobile-song-row
            :key="song.id"
            :song="song"
            @play="play(song)"
            @open-actions="openActions(song)"
          />
        </template>
      </v-virtual-scroll>
      <v-virtual-scroll v-else renderless :items="filteredAlbums" :item-height="MOBILE_ROW_HEIGHT">
        <template #default="{ item: album }">
          <mobile-album-row :key="album.id" :album="album" @play="playAlbum(album)" />
        </template>
      </v-virtual-scroll>
    </div>

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
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import type { Album, Song } from '@/types/library'

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
      MOBILE_ROW_HEIGHT,
      view: 'songs' as 'songs' | 'albums',
      filterQuery: '',
      debouncedQuery: '',
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
        matchesAllTerms(query, [song.title, song.artist, song.album], { exact: true }),
      )
    },
    filteredAlbums(): Album[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.albums
      return this.libraryStore.albums.filter((album: Album) =>
        matchesAllTerms(query, [album.name, album.artist], { exact: true }),
      )
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
      }, 200)
    },
    /** The search deliberately survives the switch: noticing you are in the
     * wrong half is usually what makes you switch in the first place, and
     * having to retype the term you just entered is a penalty for one tap.
     * The field is clearable, which is the cheaper way out for the rarer
     * case of actually wanting a fresh search. */
    view() {
      if (!this.showingSongs) void this.libraryStore.fetchAlbums()
      this.rememberSearch()
    },
    debouncedQuery: 'rememberSearch',
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
      const tab = this.$route?.query?.tab
      if (tab === 'albums' || tab === 'songs') this.view = tab
      const term = this.$route?.query?.q
      if (typeof term !== 'string' || !term) return
      this.filterQuery = term
      this.debouncedQuery = term
    },
    /** Puts the search and the half being browsed in the address, so coming
     * back from an album (this list is the only way to one, see
     * MobileAlbumRow.vue) finds them still there. This view is unmounted
     * while the album is open, so anything held in data() alone is gone by
     * the time it is looked at again.
     *
     * replace(), not push(): every keystroke would otherwise become a stop
     * on the way out, and pressing back would walk the search backwards one
     * letter at a time instead of leaving the library. */
    rememberSearch() {
      if (!this.$router || !this.$route) return
      const query: Record<string, string> = {}
      for (const [key, value] of Object.entries(this.$route.query)) {
        if (typeof value === 'string') query[key] = value
      }
      if (this.debouncedQuery) query.q = this.debouncedQuery
      else delete query.q
      if (this.view === 'albums') query.tab = 'albums'
      else delete query.tab
      if (query.q === this.$route.query.q && query.tab === this.$route.query.tab) return
      void this.$router.replace({ query })
    },
    /** The tapped song alone, not the list around it. This list is the
     * whole catalogue, or whatever a search term happened to match - a set
     * of matches rather than a sequence anyone meant to hear in order, so
     * playing one of them must not queue the rest behind it. Same rule as
     * SongsView and the search results on the desktop (SongTable.vue's
     * `queueWholeList`), and as this view's own action sheet, whose Play
     * already did exactly this - tapping the row and picking Play from the
     * "..." menu were two different actions until now. */
    async play(song: Song) {
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
</style>
