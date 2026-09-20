<template>
  <!-- The album's artist background from Fanart.tv, full-bleed across the
   - top of the page and masked out towards the bottom so the track list
   - below sits on the plain surface. Without one it falls back to the
   - blurred album cover wash, so the page never looks bare. -->
  <detail-page-backdrop :url="backdropUrl" :is-photo="backdropIsPhoto" :show="Boolean(album)" short>
    <v-container v-if="album" fluid>
      <detail-hero
        :name="album.name"
        :eyebrow="$t('library.album')"
        :cover-art-id="album.coverArtId"
        fallback-icon="mdi-album"
        :starred="authStore.capabilities.favorites ? album.starred : null"
        :rating="authStore.capabilities.personalRating ? album.rating : null"
        @toggle-star="toggleStar"
        @set-rating="setRating"
      >
        <template #subtitle>
          <router-link
            :to="`/artists/${album.artistId}`"
            class="text-body-large detail-hero__subtitle-link"
          >
            {{ album.artist }}
          </router-link>
        </template>
        <template #meta>
          {{ album.year ?? '' }} · {{ $t('library.songCount', { count: album.songCount }) }}
        </template>
      </detail-hero>

      <song-table
        :songs="album.songs"
        :default-sort-key="null"
        group-by-disc
        :exclude-columns="['cover', 'album']"
        class="album-tracks"
      />
    </v-container>
    <v-container v-else>
      <page-loader v-if="libraryStore.loading" />
      <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
        {{ libraryStore.error }}
      </v-alert>
    </v-container>
  </detail-page-backdrop>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import DetailHero from '@/components/library/DetailHero.vue'
import DetailPageBackdrop from '@/components/library/DetailPageBackdrop.vue'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import { getArtistArt, type ArtistArt } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'

export default {
  name: 'AlbumDetailView',
  components: { DetailHero, DetailPageBackdrop, SongTable, PageLoader },
  data() {
    return {
      album: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchAlbum']>> | null,
      // The album artist's Fanart.tv images (background only used here),
      // when the installation has Fanart.tv on and the artist has them.
      // Null falls back to the blurred album cover backdrop.
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
    /** The page backdrop: the album artist's Fanart.tv background when
     * there is one, else the blurred album cover wash. Held back until the
     * Fanart lookup has answered, so it appears once rather than swapping. */
    backdropUrl(): string | null {
      if (!this.artResolved) return null
      if (this.artistArt?.background) return this.artistArt.background
      if (!this.album) return null
      if (this.album.coverArtId) {
        return useLibraryStore().client().coverArtUrl(this.album.coverArtId, 300)
      }
      return null
    },
    backdropIsPhoto(): boolean {
      return Boolean(this.artistArt?.background)
    },
    fanartEnabled(): boolean {
      return useFanartStore().enabled
    },
  },
  created() {
    this.loadAlbum()
  },
  watch: {
    '$route.params.id': 'loadAlbum',
    // Turning Fanart.tv off clears the background immediately; turning it
    // back on fetches it again - no reload needed.
    fanartEnabled() {
      if (!this.album) return
      void this.loadArt(this.album.artist, this.album.id)
    },
  },
  methods: {
    async loadAlbum() {
      const id = this.$route.params.id as string
      this.artistArt = null
      this.artResolved = false
      try {
        const album = await this.libraryStore.fetchAlbum(id)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.$route.params.id !== id) return
        this.album = album
        void this.loadArt(album.artist, id)
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[album-detail] Failed to load album:', error)
      }
    },
    // Fired and forgotten: a failure (or no Fanart.tv key, or no images)
    // simply leaves the page on its blurred cover backdrop.
    async loadArt(name: string, id: string) {
      // Held back (see artResolved): the backdrop stays empty until the
      // lookup answers, then fades in once - the answer or the cover -
      // rather than showing the cover and swapping it out.
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
        console.error('[album-detail] Fanart.tv lookup failed:', error)
      }
      if (this.$route.params.id !== id) return
      // Preload before setting it: the backdrop fades in, and that only
      // reads as a fade if the image is already paintable when it is shown.
      if (art?.background) await preloadImage(art.background)
      if (this.$route.params.id !== id) return
      this.artistArt = art
      this.artResolved = true
    },
    async toggleStar() {
      if (!this.album) return
      await this.libraryStore.toggleStar({ albumId: this.album.id, starred: this.album.starred })
      this.album.starred = !this.album.starred
    },
    async setRating(rating: number) {
      if (!this.album) return
      const previous = this.album.rating
      this.album.rating = rating
      try {
        await this.libraryStore.setRating(this.album.id, rating)
      } catch (error) {
        this.album.rating = previous
        console.error('[album-detail] Failed to set rating:', error)
      }
    },
  },
}
</script>

<style scoped>
/* Held down off the hero so the Fanart.tv background above it has room to
 * fade out before the rows start (see DetailPageBackdrop.vue's short band). */
.album-tracks {
  margin-top: 96px;
}

/* Link styling lives here, on the actual link, not on DetailHero.vue's
 * generic .detail-hero__subtitle wrapper — that wrapper is shared with the
 * artist page's own subtitle slot. */
.detail-hero__subtitle-link {
  color: rgba(255, 255, 255, 0.75);
  text-decoration: none;
}

.detail-hero__subtitle-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
</style>
