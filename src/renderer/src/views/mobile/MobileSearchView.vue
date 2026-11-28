<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">
        {{ query ? $t('search.resultsFor', { query }) : $t('search.label') }}
      </h1>
    </div>
    <div v-if="kind && query" class="mobile-search__kind">
      <h2 class="section-title">{{ kindTitle }}</h2>
    </div>

    <empty-state v-if="!query" icon="mdi-magnify" :title="$t('search.everythingHint')" />
    <page-loader
      v-else-if="libraryStore.loading && !sections.length && !kindItems.length"
      :label="$t('search.searching')"
    />
    <!-- One kind's every match, from its "show all": as long as a list in
       - the library can be, so virtualized like those. -->
    <div v-else-if="kind" class="mobile-search__list">
      <v-virtual-scroll renderless :items="kindItems" :item-height="MOBILE_ROW_HEIGHT">
        <template #default="{ item }">
          <mobile-song-row
            v-if="kind === 'songs'"
            :key="item.id"
            :song="item as Song"
            @play="playSong(item as Song)"
            @open-actions="openActions(item as Song)"
          />
          <mobile-album-row
            v-else-if="kind === 'albums'"
            :key="`al-${item.id}`"
            :album="item as Album"
            @play="playAlbum(item as Album)"
          />
          <mobile-artist-row v-else :key="`ar-${item.id}`" :artist="item as Artist" />
        </template>
      </v-virtual-scroll>
    </div>
    <template v-else>
      <mobile-search-results
        :sections="sections"
        @show-all="showAll"
        @play-song="playSong"
        @play-album="playAlbum"
        @play-playlist="playPlaylist"
        @play-station="playStation"
        @open-actions="openActions"
      />
      <sonic-search-section
        v-for="sonicKind in SONIC_KINDS"
        :key="sonicKind"
        :kind="sonicKind"
        :query="query"
        :limit="LIMITS.songs"
        compact
        @play-song="playSong"
        @open-actions="openActions"
        @showing="sonicShowing[sonicKind] = $event"
      />
      <empty-state
        v-if="!sections.length && !sonicShowing.sound && !sonicShowing.lyrics"
        icon="mdi-magnify-close"
        :title="$t('search.noResults', { query })"
        :text="$t('search.noResultsHint')"
      />
    </template>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import EmptyState from '@/components/EmptyState.vue'
import PageLoader from '@/components/PageLoader.vue'
import MobileSearchResults from '@/components/mobile/MobileSearchResults.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileArtistRow from '@/components/mobile/MobileArtistRow.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import SonicSearchSection from '@/components/library/SonicSearchSection.vue'
import type { SonicSearchKind } from '@/services/connect/audiomuse'
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import {
  searchEverything,
  type SearchLimits,
  type SearchSection,
  type SearchSources,
} from '@/services/library/searchEverything'
import type { Album, Artist, Playlist, RadioStation, Song } from '@/types/library'

/** The kinds with a "show all": the ones that run long enough for it. */
type ListedKind = 'songs' | 'albums' | 'artists'
const LISTED_KINDS: ListedKind[] = ['songs', 'albums', 'artists']

/** How many of each kind show before "show all". */
const LIMITS: SearchLimits = {
  artists: 3,
  albums: 4,
  songs: 8,
  playlists: 5,
  stations: 5,
}

const EMPTY_SOURCES: SearchSources = {
  artists: [],
  albums: [],
  songs: [],
  playlists: [],
  stations: [],
}

/** The phone's search page, fed by the app bar's field
 * (MobileTopBarSearch.vue): every kind at once, the best-fitting first. */
export default {
  name: 'MobileSearchView',
  components: {
    EmptyState,
    PageLoader,
    MobileSearchResults,
    MobileSongActionSheet,
    MobileAlbumRow,
    MobileArtistRow,
    MobileSongRow,
    SonicSearchSection,
  },
  data() {
    return {
      MOBILE_ROW_HEIGHT,
      LIMITS,
      SONIC_KINDS: ['sound', 'lyrics'] as SonicSearchKind[],
      // See SearchView.vue's own sonicShowing.
      sonicShowing: { sound: false, lyrics: false } as Record<SonicSearchKind, boolean>,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    hasRadio(): boolean {
      return useAuthStore().capabilities.internetRadio
    },
    query(): string {
      const q = this.$route.query.q
      return typeof q === 'string' ? q.trim() : ''
    },
    kind(): ListedKind | null {
      const kind = this.$route.query.kind
      return LISTED_KINDS.includes(kind as ListedKind) ? (kind as ListedKind) : null
    },
    kindTitle(): string {
      if (this.kind === 'artists') return this.$t('search.artists')
      return this.kind === 'albums' ? this.$t('search.albums') : this.$t('search.songs')
    },
    sources(): SearchSources {
      const store = this.libraryStore
      return {
        artists: store.artists,
        albums: store.albums,
        songs: store.allSongs,
        playlists: store.playlists,
        stations: this.hasRadio ? store.radioStations : [],
      }
    },
    sections(): SearchSection[] {
      if (this.kind) return []
      return searchEverything(this.query, this.sources, LIMITS)
    },
    /** Every match of the one kind, ranked the same way as its section. */
    kindItems(): (Song | Album | Artist)[] {
      const kind = this.kind
      if (!kind) return []
      const sources = { ...EMPTY_SOURCES, [kind]: this.sources[kind] }
      const limits = { ...LIMITS, [kind]: Number.POSITIVE_INFINITY }
      const [section] = searchEverything(this.query, sources, limits)
      return (section?.items ?? []) as (Song | Album | Artist)[]
    },
  },
  created() {
    const store = this.libraryStore
    void store.fetchAllSongs()
    void store.fetchAlbums()
    void store.fetchArtists()
    void store.fetchPlaylists()
    // Not cached like the others, so asked for only once per session.
    if (this.hasRadio && !store.radioStations.length) void store.fetchRadioStations()
  },
  methods: {
    /** Every match of that kind, as a step back from to the overview. */
    showAll(kind: keyof SearchSources) {
      void this.$router.push({ name: 'm-search', query: { q: this.query, kind } })
    },
    /** One song, not the matches around it - the same rule as the
     * desktop's search page. */
    async playSong(song: Song) {
      await usePlaybackStore().playSongList([song], 0)
    },
    /** Same call the library's album rows make. */
    async playAlbum(album: Album) {
      const full = await this.libraryStore.fetchAlbum(album.id)
      await usePlaybackStore().playSongList(full.songs, 0, false, true)
    },
    /** Same call MobilePlaylistsView.vue makes. */
    async playPlaylist(playlist: Playlist) {
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      await usePlaybackStore().playSongList(full.songs, 0, false)
    },
    playStation(station: RadioStation) {
      void usePlaybackStore().playRadioStation(station)
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-search__kind {
  margin-bottom: 4px;
}

.mobile-search__list {
  display: flex;
  flex-direction: column;
}
</style>
