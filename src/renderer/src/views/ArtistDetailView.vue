<template>
  <div class="artist-page">
    <!-- The artist's own Fanart.tv background, full-bleed across the top of
     - the page and masked out towards the bottom so the albums and songs
     - below sit on the plain surface. Without one it falls back to the
     - blurred cover wash, so the page never looks bare. -->
    <div
      v-if="artist"
      class="artist-page__backdrop"
      :class="{
        'artist-page__backdrop--photo': backdropIsPhoto,
        'artist-page__backdrop--shown': Boolean(backdropUrl),
      }"
      :style="backdropUrl ? { backgroundImage: `url(${backdropUrl})` } : {}"
    />
    <div v-if="artist" class="artist-page__scrim" />

    <v-container v-if="artist" fluid class="artist-page__content">
      <artist-hero
        :name="artist.name"
        :eyebrow="$t('library.artist')"
        :cover-art-id="artist.coverArtId"
        :image-url="artist.imageUrl"
        :logo-url="artistLogo"
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
        <template v-if="bio" #description>
          <artist-bio :text="bio.text" :url="bio.url" :lang="bio.lang" />
        </template>
        <!-- v-if on the template tag itself, not just the content inside —
         - ArtistHero.vue only renders its own #actions wrapper when this
         - slot is provided at all, regardless of what's actually inside it.
         - Guarding here means neither Artist Radio nor the external-link
         - icons existing yet (capability off, still loading, nothing found)
         - doesn't reserve a gap for nothing. -->
        <template v-if="authStore.capabilities.songRadio || externalLinks.length" #actions>
          <div class="artist-hero__actions-row">
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
      </artist-hero>

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
        />
      </template>
    </v-container>
    <v-container v-else>
      <page-loader v-if="libraryStore.loading" />
      <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
        {{ libraryStore.error }}
      </v-alert>
    </v-container>
  </div>
</template>

<script lang="ts">
import { useLibraryStore, TOP_SONGS_LIMIT } from '@/stores/library'
import { artistNameKey } from '@/services/artistCredits'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import ArtistHero from '@/components/library/ArtistHero.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import { readCardGridView, writeCardGridView } from '@/services/cardGridView'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import {
  getArtistBio,
  getArtistImages,
  getArtistLinks,
  type ArtistBio as ArtistBioData,
} from '@/services/connect/recommendations'
import ArtistBio from '@/components/library/ArtistBio.vue'
import { getArtistArt, type ArtistArt } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'
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
  components: { ArtistHero, AlbumShelf, SongTable, PageLoader, ArtistBio },
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
      bio: null as ArtistBioData | null,
      // The artist's Fanart.tv images (background, clear logo), when the
      // installation has a key and the artist has them. Null falls back to
      // the blurred cover backdrop and the plain-text name.
      artistArt: null as ArtistArt | null,
      // Whether the Fanart.tv lookup has finished (either way). The backdrop
      // is held back until it has, so it appears once - the answer or the
      // cover - instead of showing the cover and then swapping.
      artResolved: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    /** How many songs this artist has, for the header and for deciding
     * whether the "show all" toggle has anything to offer.
     *
     * The server's own figure wherever it reports one: summing their albums
     * misses exactly the tracks the table below now shows, the ones on
     * somebody else's record (see fetchAllSongsForArtist()). Where it does
     * not, the album sum is still the best guess available, floored by what
     * has actually been loaded so an artist with no albums at all does not
     * claim to have nothing. */
    totalSongCount(): number {
      const counted = this.artist
        ? this.libraryStore.trackCountByArtistName.get(artistNameKey(this.artist.name))
        : undefined
      if (this.libraryStore.allSongsLoaded && counted !== undefined) return counted
      const fromAlbums = this.artist?.albums.reduce((sum, album) => sum + album.songCount, 0) ?? 0
      return Math.max(fromAlbums, this.allTopSongs?.length ?? this.topSongs.length)
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
    /** The artist's Fanart.tv clear logo, or null for the plain-text name. */
    artistLogo(): string | null {
      return this.artistArt?.logo ?? null
    },
    /** The page backdrop: the Fanart.tv background when there is one, else
     * the blurred cover wash (see the template). Held back until the Fanart
     * lookup has answered, so it appears once rather than swapping. */
    backdropUrl(): string | null {
      if (!this.artResolved) return null
      if (this.artistArt?.background) return this.artistArt.background
      if (!this.artist) return null
      if (this.artist.coverArtId) {
        return useLibraryStore().client().coverArtUrl(this.artist.coverArtId, 300)
      }
      return this.artist.imageUrl
    },
    backdropIsPhoto(): boolean {
      return Boolean(this.artistArt?.background)
    },
    fanartEnabled(): boolean {
      return useFanartStore().enabled
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
    // A different Wikipedia, not just different labels around the same text.
    '$i18n.locale'() {
      if (this.artist) void this.loadBio(this.artist.name, this.artist.id)
    },
    // Turning Fanart.tv off clears the images immediately; turning it back
    // on fetches them again - no reload needed. Both go through loadArt() so
    // the backdrop is held back the same way on either change.
    fanartEnabled() {
      if (!this.artist) return
      void this.loadArt(this.artist.name, this.artist.id)
    },
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
      this.bio = null
      this.artistArt = null
      this.artResolved = false
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
      void this.loadBio(artist.name, id)
      void this.loadArt(artist.name, id)

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
    // Same terms as loadExternalLinks() above: fired and forgotten, and a
    // failure just leaves the paragraph out.
    async loadBio(name: string, id: string) {
      const locale = this.$i18n.locale
      let bio: ArtistBioData | null = null
      try {
        bio = await getArtistBio(name, locale)
      } catch (error) {
        console.error('[artist-detail] Artist bio lookup failed:', error)
      }
      if (this.$route.params.id !== id || this.$i18n.locale !== locale) return
      this.bio = bio
    },
    // Same terms as loadBio() above: fired and forgotten, and a failure (or
    // no Fanart.tv key, or no images) simply leaves the page on its blurred
    // cover backdrop and its plain-text name.
    async loadArt(name: string, id: string) {
      // Held back (see artResolved): the backdrop stays empty until the
      // lookup answers, then fades in once - the answer or the cover - rather
      // than showing the cover and swapping it out.
      this.artResolved = false
      if (!useFanartStore().enabled) {
        this.artistArt = null
        this.artResolved = true
        return
      }
      let art: ArtistArt | null = null
      try {
        art = await getArtistArt(name)
      } catch (error) {
        console.error('[artist-detail] Fanart.tv lookup failed:', error)
      }
      if (this.$route.params.id !== id) return
      // Preload before setting them: the backdrop fades in and the logo
      // swaps in, and both only read as a fade if the images are already
      // paintable when they are shown.
      if (art?.background) await preloadImage(art.background)
      if (art?.logo) await preloadImage(art.logo)
      if (this.$route.params.id !== id) return
      this.artistArt = art
      this.artResolved = true
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
/* The full-bleed artist backdrop: a band across the top of the page, masked
 * out towards the bottom so the albums and songs below sit on the plain
 * surface. */
.artist-page {
  position: relative;
}

.artist-page__backdrop,
.artist-page__scrim {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: min(78vh, 680px);
  pointer-events: none;
}

.artist-page__backdrop {
  background-size: cover;
  background-position: center 22%;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  /* Held back until the Fanart lookup answers (see backdropUrl), then faded
   * in - so it never shows the cover and swaps to the background. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.artist-page__backdrop--shown {
  opacity: 1;
}

/* Without a Fanart.tv background the fallback is the blurred cover wash -
 * the app's one backdrop recipe (see docs/styleguide.md). */
.artist-page__backdrop:not(.artist-page__backdrop--photo) {
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.1);
  transform-origin: top center;
}

/* Keeps the header text readable over a bright background photo, and eases
 * the top edge into the chrome. */
.artist-page__scrim {
  background: linear-gradient(
    to bottom,
    rgba(18, 20, 28, 0.72) 0%,
    rgba(18, 20, 28, 0.3) 38%,
    rgba(18, 20, 28, 0) 100%
  );
}

.artist-page__content {
  position: relative;
  z-index: 1;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* Artist Radio + the external-link icons share one row, wrapping onto a
 * second line rather than overflowing/squeezing on a narrow window. */
.artist-hero__actions-row {
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
