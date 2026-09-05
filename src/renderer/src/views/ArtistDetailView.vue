<template>
  <v-container v-if="artist" fluid>
    <detail-header
      :cover-art-id="artist.coverArtId"
      :image-url="artist.imageUrl"
      :size="160"
      :eyebrow="$t('library.artist')"
      :title="artist.name"
      :starred="authStore.capabilities.favorites ? artist.starred : null"
      :rating="authStore.capabilities.personalRating ? artist.rating : null"
      @toggle-star="toggleStar"
      @set-rating="setRating"
    >
      <template #meta>
        {{ artist.albumCount }}
        {{ artist.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }} ·
        {{ totalSongCount }}
        {{ totalSongCount === 1 ? $t('library.song1') : $t('library.songsN') }}
      </template>
      <!-- v-if on the template tag itself, not just the content inside —
       - DetailHeader.vue only renders its own #actions wrapper (reserving
       - margin-top, see that component's own comment on $slots.actions)
       - when this slot is provided at all, regardless of what's actually
       - inside it. Guarding here means neither Artist Radio nor the
       - external-link icons existing yet (capability off, still loading,
       - nothing found) doesn't reserve a gap for nothing. Icons moved here
       - from their old #top-right spot (see TODO.md) — up to 7 of them
       - crammed into that absolute-positioned corner alongside the rating/
       - heart row was cramped; this is normal reading-flow layout with
       - room to wrap instead. -->
      <template v-if="authStore.capabilities.songRadio || externalLinks.length" #actions>
        <div class="detail-header__actions-row">
          <v-btn
            v-if="authStore.capabilities.songRadio"
            color="primary"
            rounded="pill"
            prepend-icon="mdi-radio-tower"
            @click="startArtistRadio"
          >
            {{ $t('library.artistRadio') }}
          </v-btn>
          <v-btn
            v-for="link in externalLinks"
            :key="link.key"
            icon
            size="small"
            variant="text"
            :href="link.url"
            target="_blank"
            rel="noopener"
            :title="$t('library.viewOnService', { service: link.name })"
          >
            <img
              :src="link.icon"
              :alt="link.name"
              class="external-link-icon"
              :class="{ 'external-link-icon--invert': link.invert }"
            />
          </v-btn>
        </div>
      </template>
    </detail-header>

    <!-- A grid toggle like the favorites page's and the search results',
     - remembered per visit: an artist with three albums and one with sixty
     - want different layouts, and the answer belongs to the page rather
     - than to the artist currently on it. -->
    <album-shelf
      :title="$t('library.albums')"
      :albums="sortedAlbums"
      :show-play-all="false"
      :wrap="albumGridView"
      wrap-toggle
      @update:wrap="setAlbumGridView"
    >
      <template #action>
        <v-btn
          :icon="
            albumSortAscending ? 'mdi-sort-calendar-descending' : 'mdi-sort-calendar-ascending'
          "
          variant="text"
          size="small"
          density="comfortable"
          :title="albumSortAscending ? $t('library.newestFirst') : $t('library.oldestFirst')"
          @click="albumSortAscending = !albumSortAscending"
        />
      </template>
    </album-shelf>

    <template v-if="topSongs.length || loadingTopSongs">
      <div class="section-header">
        <h2 class="section-title">
          {{ allSongsShown ? $t('library.allSongs') : $t('library.mostPlayed') }}
        </h2>
        <!-- Only once the artist actually has more songs than
         - TOP_SONGS_LIMIT (totalSongCount is every song across every
         - album) — otherwise there'd be nothing for the toggle to do.
         - Stays visible in both states, swapping label/target so it can
         - toggle back and forth instead of only ever expanding once. -->
        <v-btn
          v-if="canToggleAllSongs"
          variant="text"
          size="small"
          :loading="loadingAllSongs"
          :disabled="loadingAllSongs"
          @click="toggleAllTopSongs"
        >
          {{ allSongsShown ? $t('library.showLess') : $t('library.showAllSongs') }}
        </v-btn>
      </div>
      <song-table
        :songs="displayedTopSongs"
        :loading="loadingTopSongs"
        default-sort-key="playCount"
        default-sort-direction="desc"
        show-cover
        show-album
        show-genre
        show-year
        show-play-count
        show-format
      />
    </template>
  </v-container>
  <v-container v-else>
    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
      {{ libraryStore.error }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore, TOP_SONGS_LIMIT } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import DetailHeader from '@/components/library/DetailHeader.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import { readCardGridView, writeCardGridView } from '@/services/cardGridView'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import { getArtistImages, getArtistLinks } from '@/services/connect/recommendations'
import { toExternalLinkList, type ExternalLinkKey } from '@/components/library/externalArtistLinks'
import type { Song } from '@/types/library'

// Artist detail (with its own .albums, unlike the plain library-store
// Artist type) — named here so data()'s own field below doesn't have to
// repeat this whole ReturnType chain inline.
type ArtistDetail = Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchArtist']>>

// The albums on an artist's page, shelf or grid. One key for the page as a
// whole rather than one per artist — see services/cardGridView.ts.
const ALBUM_GRID_VIEW_KEY = 'beacon.artistGridView.albums'

export default {
  name: 'ArtistDetailView',
  components: { DetailHeader, AlbumShelf, SongTable, PageLoader },
  data() {
    return {
      artist: null as ArtistDetail | null,
      albumGridView: readCardGridView(ALBUM_GRID_VIEW_KEY),
      // Newest-first (descending by year) by default — see this file's own
      // #action template comment. Reset per artist in loadArtist() so a
      // toggle made on one artist page doesn't carry over to the next.
      albumSortAscending: false,
      // The default capped fetch (top TOP_SONGS_LIMIT by playCount) —
      // always loaded, and what's shown while allSongsShown is false. See
      // displayedTopSongs for which of this/allTopSongs actually renders.
      topSongs: [] as Song[],
      loadingTopSongs: false,
      // Every song by the artist, lazily fetched the first time
      // toggleAllTopSongs() is clicked — null until then. Cached (not
      // re-fetched) once loaded, so toggling back to the capped view and
      // forward again is instant and free the second time onward.
      allTopSongs: null as Song[] | null,
      loadingAllSongs: false,
      // Which of topSongs/allTopSongs is currently on screen — see
      // toggleAllTopSongs().
      allSongsShown: false,
      // Keyed by externalArtistLinks.ts's own keys — Deezer's url comes
      // from a different endpoint (getArtistImages(), shared with
      // HomeView.vue's own lookup) than the other six (getArtistLinks(),
      // MusicBrainz's own url-rels), merged into one map here since the
      // template only cares "is there a url for this key", not which
      // endpoint it came from.
      externalLinkUrls: {} as Partial<Record<ExternalLinkKey, string>>,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    totalSongCount() {
      return this.artist?.albums.reduce((sum, album) => sum + album.songCount, 0) ?? 0
    },
    // Whether there's actually a reason to offer the toggle at all — an
    // artist with TOP_SONGS_LIMIT songs or fewer has nothing more for
    // "Show all" to reveal. Independent of what's been fetched so far
    // (unlike allTopSongs), so the button doesn't flicker in/out across a
    // toggle the way comparing against topSongs.length would.
    canToggleAllSongs() {
      return this.totalSongCount > TOP_SONGS_LIMIT
    },
    displayedTopSongs() {
      return this.allSongsShown && this.allTopSongs ? this.allTopSongs : this.topSongs
    },
    externalLinks() {
      return toExternalLinkList(this.externalLinkUrls)
    },
    // Undated albums (year === null) sort last regardless of direction —
    // there's no sensible position for "unknown" between two known years,
    // and burying them at the end keeps the shelf's front consistently
    // meaningful either way round.
    sortedAlbums() {
      if (!this.artist) return []
      const direction = this.albumSortAscending ? 1 : -1
      return [...this.artist.albums].sort((a, b) => {
        if (a.year === null) return b.year === null ? 0 : 1
        if (b.year === null) return -1
        return (a.year - b.year) * direction
      })
    },
  },
  created() {
    this.loadArtist()
  },
  watch: {
    '$route.params.id': 'loadArtist',
  },
  methods: {
    setAlbumGridView(value: boolean) {
      this.albumGridView = value
      writeCardGridView(ALBUM_GRID_VIEW_KEY, value)
    },
    async loadArtist() {
      const id = this.$route.params.id as string
      this.topSongs = []
      this.allTopSongs = null
      this.allSongsShown = false
      this.externalLinkUrls = {}
      this.albumSortAscending = false
      // A newer navigation may resolve before this one, or move the route
      // on while a fetch is still in flight — the `$route.params.id === id`
      // checks below make sure a slower, now-stale response can't overwrite
      // whatever's actually being viewed by the time it arrives.
      let artist
      try {
        artist = await this.libraryStore.fetchArtist(id)
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[artist-detail] Failed to load artist:', error)
        return
      }
      if (this.$route.params.id !== id) return
      this.artist = artist
      void this.loadExternalLinks(artist.name, id)

      this.loadingTopSongs = true
      try {
        const topSongs = await this.libraryStore.fetchTopSongsForArtist(artist)
        if (this.$route.params.id === id) this.topSongs = topSongs
      } catch (error) {
        if (this.$route.params.id === id)
          console.error('[artist-detail] Failed to load top songs:', error)
      } finally {
        if (this.$route.params.id === id) this.loadingTopSongs = false
      }
    },
    // Toggles between the capped topSongs and the full allTopSongs — the
    // latter only actually fetched the first time this flips to "shown"
    // (see allTopSongs' own comment); every toggle after that is instant.
    async toggleAllTopSongs() {
      if (this.allSongsShown) {
        this.allSongsShown = false
        return
      }
      if (this.allTopSongs || !this.artist) {
        this.allSongsShown = true
        return
      }
      const artist = this.artist
      const id = artist.id
      this.loadingAllSongs = true
      try {
        const songs = await this.libraryStore.fetchTopSongsForArtist(artist, Infinity)
        if (this.$route.params.id === id) {
          this.allTopSongs = songs
          this.allSongsShown = true
        }
      } catch (error) {
        if (this.$route.params.id === id)
          console.error('[artist-detail] Failed to load all songs:', error)
      } finally {
        if (this.$route.params.id === id) this.loadingAllSongs = false
      }
    },
    // Fired-and-forgotten by loadArtist() rather than awaited inline — these
    // are nice-to-have icon buttons, not something the rest of the page
    // should wait on, and a lookup failure (or nothing found) should just
    // leave them hidden rather than surface an error the user can't do
    // anything about. Independent of the recommendations Settings toggle:
    // that one exists to avoid *unasked-for* background lookups for artists
    // nobody's looking at (HomeView.vue's shelves); this is a single,
    // on-demand lookup for the one artist page actually open right now, not
    // a new category of thing being sent out. Promise.allSettled, not
    // Promise.all — the Deezer and MusicBrainz-links lookups are
    // independent endpoints; one failing shouldn't hide the other's
    // results too.
    async loadExternalLinks(name: string, id: string) {
      const [images, links] = await Promise.allSettled([
        getArtistImages([name]),
        getArtistLinks([name]),
      ])
      if (this.$route.params.id !== id) return

      const urls: Partial<Record<ExternalLinkKey, string>> = {}
      if (images.status === 'fulfilled') {
        const deezerLink = images.value[name]?.link
        if (deezerLink) urls.deezer = deezerLink
      } else {
        console.error('[artist-detail] Deezer link lookup failed:', images.reason)
      }
      if (links.status === 'fulfilled') {
        Object.assign(urls, links.value[name])
      } else {
        console.error('[artist-detail] Artist links lookup failed:', links.reason)
      }
      this.externalLinkUrls = urls
    },
    async toggleStar() {
      if (!this.artist) return
      await this.libraryStore.toggleStar({ artistId: this.artist.id, starred: this.artist.starred })
      this.artist.starred = !this.artist.starred
    },
    async setRating(rating: number) {
      if (!this.artist) return
      const previous = this.artist.rating
      this.artist.rating = rating
      try {
        await this.libraryStore.setRating(this.artist.id, rating)
      } catch (error) {
        this.artist.rating = previous
        console.error('[artist-detail] Failed to set rating:', error)
      }
    },
    async startArtistRadio() {
      if (!this.artist) return
      try {
        await usePlaybackStore().startArtistRadio(this.artist)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.artistRadio'),
          message: this.$t('library.artistRadioError'),
        })
        console.error('[artist-radio]', error)
      }
    },
  },
}
</script>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* Artist Radio + the external-link icons share one row, wrapping onto a
 * second line rather than overflowing/squeezing on a narrow window - see
 * this file's own #actions template comment for why they live here now. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.external-link-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.external-link-icon--invert {
  filter: invert(1);
}

/* Its own block, set apart from the tracks above it. */
.section-header {
  margin-top: 32px;
  margin-bottom: 8px;
}
</style>
