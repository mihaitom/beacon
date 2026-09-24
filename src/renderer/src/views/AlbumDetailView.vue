<template>
  <!-- A header of fixed height with the album artist's Fanart.tv background
   - behind it (the blurred album cover wash without one), and the track
   - list scrolling on its own below, so the header stays in view. -->
  <detail-page-backdrop
    :url="backdropUrl"
    :is-photo="backdropIsPhoto"
    :show="Boolean(album)"
    banded
  >
    <v-container v-if="album" fluid class="album-header">
      <detail-hero
        :name="album.name"
        :eyebrow="releaseTypeLabel"
        :cover-art-id="album.coverArtId"
        fallback-icon="mdi-album"
        cover-size="var(--album-cover-size)"
        large
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
        <template #meta>{{ metaLine }}</template>
        <template v-if="bio" #description>
          <artist-bio
            :text="bio.text"
            :url="bio.url"
            :lang="bio.lang"
            :max-lines="3"
            :collapsed-lines="3"
          />
        </template>
        <template v-if="tags.length" #tags>
          <v-chip v-for="tag in tags" :key="tag" size="small" variant="tonal" label>
            {{ tag }}
          </v-chip>
        </template>
        <template #actions>
          <div class="album-actions">
            <v-btn
              color="primary"
              rounded="pill"
              size="large"
              prepend-icon="mdi-play"
              :disabled="!album.songs.length"
              @click="playAll"
            >
              {{ $t('library.play') }}
            </v-btn>
            <v-btn
              variant="tonal"
              rounded="pill"
              size="large"
              prepend-icon="mdi-shuffle-variant"
              :disabled="!album.songs.length"
              @click="playShuffled"
            >
              {{ $t('library.playShuffled') }}
            </v-btn>
          </div>
        </template>
      </detail-hero>
    </v-container>
    <v-container v-else>
      <page-loader v-if="libraryStore.loading" />
      <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
        {{ libraryStore.error }}
      </v-alert>
    </v-container>

    <template v-if="album" #below>
      <v-container fluid class="album-tracks">
        <song-table
          :songs="album.songs"
          :default-sort-key="null"
          group-by-disc
          sticky-header
          :exclude-columns="['cover', 'album']"
        />
      </v-container>
    </template>
  </detail-page-backdrop>
</template>

<script lang="ts">
import { formatTotalDuration } from '@/services/totalDuration'
import { useLibraryStore } from '@/stores/library'
import type { Album } from '@/types/library'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import DetailHero from '@/components/library/DetailHero.vue'
import DetailPageBackdrop from '@/components/library/DetailPageBackdrop.vue'
import SongTable from '@/components/library/SongTable.vue'
import PageLoader from '@/components/PageLoader.vue'
import { getArtistArt, type ArtistArt } from '@/services/connect/fanart'
import { getAlbumBio, type ArtistBio as ArtistBioData } from '@/services/connect/recommendations'
import ArtistBio from '@/components/library/ArtistBio.vue'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'

// Beyond this many the meta line stops being one line; the first ones are
// the ones the server ranks first.
const MAX_GENRES = 3

export default {
  name: 'AlbumDetailView',
  components: { DetailHero, DetailPageBackdrop, SongTable, PageLoader, ArtistBio },
  data() {
    return {
      album: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchAlbum']>> | null,
      // The album artist's Fanart.tv images (background only used here),
      // when the installation has Fanart.tv on and the artist has them.
      // Null falls back to the blurred album cover backdrop.
      artistArt: null as ArtistArt | null,
      // The album's Wikipedia paragraph, when MusicBrainz links an article.
      bio: null as ArtistBioData | null,
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
      if (!this.album?.coverArtId) return null
      return useLibraryStore().client().coverArtUrl(this.album.coverArtId, 300)
    },
    /** Summed from the tracks rather than the album's own duration, which
     * a bridge may send as 0. */
    durationLabel(): string {
      const seconds = this.album?.songs.reduce((total, song) => total + song.duration, 0) ?? 0
      return formatTotalDuration(seconds, this.$t)
    },
    metaLine(): string {
      if (!this.album) return ''
      const count = this.$t('library.songCount', { count: this.album.songCount })
      const genres = this.album.genres?.length ? this.album.genres : [this.album.genre]
      return [
        this.album.originalYear ?? this.album.year,
        count,
        this.durationLabel,
        genres.filter(Boolean).slice(0, MAX_GENRES).join(', '),
      ]
        .filter(Boolean)
        .join(' · ')
    },
    /** What kind of release this is ("Single", "Album · Compilation"), in
     * place of a plain "Album" over the name. A type the app has no word
     * for is shown as the server spells it. */
    releaseTypeLabel(): string {
      const types = this.album?.releaseTypes ?? []
      if (!types.length) return this.$t('library.album')
      return types
        .map((type) => {
          const key = `library.releaseTypes.${type.replace(/-/g, '')}`
          return this.$te(key) ? this.$t(key) : type.charAt(0).toUpperCase() + type.slice(1)
        })
        .join(' · ')
    },
    /** Label, edition and reissue year - the facts that are not part of
     * the meta sentence. */
    tags(): string[] {
      if (!this.album) return []
      const { labels = [], version, reissueYear } = this.album
      return [
        ...labels,
        version ?? '',
        reissueYear ? this.$t('library.reissued', { year: reissueYear }) : '',
      ].filter(Boolean)
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
    // A different Wikipedia, not just different labels around the same text.
    '$i18n.locale'() {
      if (this.album) void this.loadBio(this.album, this.album.id)
    },
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
      this.bio = null
      try {
        const album = await this.libraryStore.fetchAlbum(id)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.$route.params.id !== id) return
        this.album = album
        void this.loadArt(album.artist, id)
        void this.loadBio(album, id)
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[album-detail] Failed to load album:', error)
      }
    },
    // Fired and forgotten, like loadArt(): a failure just leaves the
    // paragraph out.
    async loadBio(album: Album, id: string) {
      const lang = this.$i18n.locale
      let bio: ArtistBioData | null = null
      try {
        bio = await getAlbumBio({ ...album, lang })
      } catch (error) {
        console.error('[album-detail] Album bio lookup failed:', error)
      }
      if (this.$route.params.id !== id || this.$i18n.locale !== lang) return
      this.bio = bio
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
    // pinFirst false: the whole album rather than a pick of one track, so
    // shuffle may reorder the first one too. peek: it replaces the queue
    // with more than one song - see peekQueueDrawer()'s own comment.
    async playAll() {
      if (!this.album?.songs.length) return
      const songs = this.album.songs
      await usePlaybackStore().playSongList(songs, 0, false, songs.length > 1)
    },
    async playShuffled() {
      const playback = usePlaybackStore()
      if (!playback.shuffle) playback.toggleShuffle()
      await this.playAll()
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
/* 40% of the window below the app bar and above the player bar; the cover
 * takes its full height less the padding, up to a share of the width so a
 * narrow window keeps room for the name beside it. */
.album-header {
  --album-cover-size: min(
    calc((100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px)) * 0.4 - 48px),
    36vw
  );
  /* A minimum rather than a height: an expanded Wikipedia paragraph
   * grows the header instead of spilling out of it. */
  min-height: calc((100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px)) * 0.4);
  display: flex;
  flex-direction: column;
  padding: 24px;
}

.album-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* The column labels stick to the top of the list's own scroll area rather
 * than below the app bar (see SongTable.vue's sticky header), a little way
 * below the header so the artist photo has faded out before their opaque
 * background starts. */
.album-tracks {
  --beacon-sticky-top: 0px;
  padding-top: 12px;
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
