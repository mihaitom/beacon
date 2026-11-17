<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">
        {{ favoritesOnly ? $t('nav.favorites') : $t('nav.library') }}
      </h1>
    </div>

    <!-- One list at a time rather than two stacked sections: a phone has
     - room for one, and the search below applies to whichever is showing
     - (see searchLabel). Artists open their own page
     - (MobileArtistDetailView.vue) rather than playing. -->
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
        @update:model-value="view = $event as LibraryTab"
      />
      <v-text-field
        v-model="filterQuery"
        :label="searchLabel"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        hide-details
      >
        <!-- Favourites are this list narrowed down rather than a tab of
           - their own: the same three halves, the same rows, and the search
           - comes along. In the field's end like the desktop's "Aa"
           - (ExactMatchSwitch.vue), since it belongs to what is searched. -->
        <template v-if="canFilterFavorites" #append-inner>
          <v-btn
            :icon="favoritesOnly ? 'mdi-heart' : 'mdi-heart-outline'"
            size="small"
            variant="text"
            class="mobile-library__favorites"
            :class="{ 'mobile-library__favorites--on': favoritesOnly }"
            :title="$t('library.favoritesOnly')"
            :aria-label="$t('library.favoritesOnly')"
            :aria-pressed="favoritesOnly"
            @click.stop="favoritesOnly = !favoritesOnly"
          />
        </template>
      </v-text-field>
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
        <template #default="{ item: song, index }">
          <mobile-song-row
            :key="song.id"
            :song="song"
            @play="play(song, index)"
            @open-actions="openActions(song)"
          />
        </template>
      </v-virtual-scroll>
      <v-virtual-scroll
        v-else-if="view === 'albums'"
        renderless
        :items="filteredAlbums"
        :item-height="MOBILE_ROW_HEIGHT"
      >
        <template #default="{ item: album }">
          <mobile-album-row :key="album.id" :album="album" @play="playAlbum(album)" />
        </template>
      </v-virtual-scroll>
      <v-virtual-scroll v-else renderless :items="filteredArtists" :item-height="MOBILE_ROW_HEIGHT">
        <template #default="{ item: artist }">
          <mobile-artist-row :key="artist.id" :artist="artist" />
        </template>
      </v-virtual-scroll>
    </div>

    <empty-state
      v-if="showEmptyState"
      :icon="emptyIcon"
      :title="emptyMessage"
      :text="favoritesOnly && !debouncedQuery ? $t('favorites.emptyHint') : undefined"
    />

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileArtistRow from '@/components/mobile/MobileArtistRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import type { Album, Artist, Song } from '@/types/library'

type LibraryTab = 'songs' | 'albums' | 'artists'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

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
    MobileSongRow,
    MobileAlbumRow,
    MobileArtistRow,
    MobileSongActionSheet,
    SegmentedControl,
    StickyFilter,
  },
  data() {
    return {
      MOBILE_ROW_HEIGHT,
      view: 'songs' as LibraryTab,
      favoritesOnly: favoritesOnlyThisSession,
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
    viewOptions() {
      return [
        { title: this.$t('library.songs'), value: 'songs' },
        { title: this.$t('library.albums'), value: 'albums' },
        { title: this.$t('library.artists'), value: 'artists' },
      ]
    },
    searchLabel(): string {
      if (this.view === 'artists') return this.$t('library.searchArtists')
      return this.showingSongs ? this.$t('library.searchSongs') : this.$t('library.searchAlbums')
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.songs
      return this.songs.filter((song: Song) =>
        matchesAllTerms(query, [song.title, song.artist, song.album], { exact: true }),
      )
    },
    filteredAlbums(): Album[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.albums
      return this.albums.filter((album: Album) =>
        matchesAllTerms(query, [album.name, album.artist], { exact: true }),
      )
    },
    filteredArtists(): Artist[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.artists
      return this.artists.filter((artist: Artist) =>
        matchesAllTerms(query, [artist.name], { exact: true }),
      )
    },
    showEmptyState(): boolean {
      if (this.libraryStore.loading) return false
      if (this.view === 'artists') return this.filteredArtists.length === 0
      return this.showingSongs ? this.filteredSongs.length === 0 : this.filteredAlbums.length === 0
    },
    emptyIcon(): string {
      if (this.debouncedQuery) return 'mdi-magnify-close'
      return this.favoritesOnly ? 'mdi-heart-outline' : 'mdi-music-note-off'
    },
    emptyMessage(): string {
      const query = this.debouncedQuery
      if (this.favoritesOnly && !query) {
        if (this.view === 'artists') return this.$t('favorites.noArtistsYet')
        return this.showingSongs
          ? this.$t('favorites.noSongsYet')
          : this.$t('favorites.noAlbumsYet')
      }
      if (this.view === 'artists') {
        return query
          ? this.$t('library.noArtistsForQuery', { query })
          : this.$t('library.noArtistsFound')
      }
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
    view(view: LibraryTab) {
      if (view === 'albums') void this.libraryStore.fetchAlbums()
      if (view === 'artists') void this.libraryStore.fetchArtists()
      this.rememberSearch()
    },
    debouncedQuery: 'rememberSearch',
    // Immediate for the fetch only: the address is written once created()
    // has read the one it arrived with, or this would overwrite it first.
    favoritesOnly: {
      immediate: true,
      handler(on: boolean, previous: boolean | undefined) {
        favoritesOnlyThisSession = on
        if (on) void this.libraryStore.fetchStarred()
        if (previous !== undefined) this.rememberSearch()
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
    // Not created() alone: Vue Router reuses this component when only the
    // query changes, so a second hand-over while already here would be
    // silently ignored. Same reason SearchView.vue watches its own.
    '$route.query.q': 'applyHandedOverSearch',
  },
  created() {
    this.libraryStore.fetchAllSongs()
    this.applyHandedOverSearch()
    // A filter kept from earlier in the session goes into the address too.
    if (this.favoritesOnly) this.rememberSearch()
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
      if (tab === 'albums' || tab === 'songs' || tab === 'artists') this.view = tab
      if (this.$route?.query?.favorites) this.favoritesOnly = true
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
      if (this.view === 'songs') delete query.tab
      else query.tab = this.view
      if (this.favoritesOnly) query.favorites = '1'
      else delete query.favorites
      if (
        query.q === this.$route.query.q &&
        query.tab === this.$route.query.tab &&
        query.favorites === this.$route.query.favorites
      ) {
        return
      }
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

/* ExactMatchSwitch.vue's pill and amber, so the two field-end toggles in
 * the app read alike. */
.mobile-library__favorites.v-btn {
  width: 32px;
  height: 28px;
  margin-right: -6px;
  border-radius: 9999px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.mobile-library__favorites--on.v-btn {
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.14);
}

.mobile-library__list {
  display: flex;
  flex-direction: column;
}
</style>
