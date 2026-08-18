<template>
  <v-container v-if="album" fluid>
    <detail-header
      :cover-art-id="album.coverArtId"
      :size="200"
      :eyebrow="$t('library.album')"
      :title="album.name"
      :starred="authStore.capabilities.favorites ? album.starred : null"
      :rating="authStore.capabilities.personalRating ? album.rating : null"
      @toggle-star="toggleStar"
      @set-rating="setRating"
    >
      <template #subtitle>
        <router-link
          :to="`/artists/${album.artistId}`"
          class="text-subtitle-1 detail-header__subtitle-link"
        >
          {{ album.artist }}
        </router-link>
      </template>
      <template #meta>
        {{ album.year ?? '' }} · {{ $t('library.songCount', { count: album.songCount }) }}
      </template>
    </detail-header>

    <track-list
      :tracks="album.tracks"
      :default-sort-key="null"
      group-by-disc
      disable-pagination
      show-genre
      show-year
      show-play-count
      show-format
    />
  </v-container>
  <v-container v-else>
    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
      {{ libraryStore.error }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import DetailHeader from '@/components/library/DetailHeader.vue'
import TrackList from '@/components/library/TrackList.vue'
import PageLoader from '@/components/PageLoader.vue'

export default {
  name: 'AlbumDetailView',
  components: { DetailHeader, TrackList, PageLoader },
  data() {
    return {
      album: null as Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchAlbum']>> | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
  },
  created() {
    this.loadAlbum()
  },
  watch: {
    '$route.params.id': 'loadAlbum',
  },
  methods: {
    async loadAlbum() {
      const id = this.$route.params.id as string
      try {
        const album = await this.libraryStore.fetchAlbum(id)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.$route.params.id === id) this.album = album
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[album-detail] Failed to load album:', error)
      }
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
/* Link styling lives here, on the actual link, not on DetailHeader.vue's
 * generic .detail-header__subtitle wrapper — that wrapper is shared with
 * PlaylistDetailView.vue's non-interactive "by {owner}" text, which a
 * hover-to-underline effect on the wrapper itself would have misleadingly
 * applied to as well. */
.detail-header__subtitle-link {
  color: rgba(255, 255, 255, 0.75);
  text-decoration: none;
}

.detail-header__subtitle-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
</style>
