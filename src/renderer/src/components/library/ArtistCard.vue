<template>
  <div class="artist-card" @click="$router.push(`/artists/${artist.id}`)">
    <div class="artist-card-cover">
      <cover-art :cover-art-id="artist.coverArtId" :image-url="artist.imageUrl" :size="160" />
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="artist.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="artist.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="artist-card-star"
        :class="{ 'artist-card-star--visible': artist.starred }"
        :title="$t(artist.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </div>
    <div class="artist-card-name text-body-2 mt-2 text-truncate">{{ artist.name }}</div>
    <div class="text-caption text-medium-emphasis text-truncate">
      {{ artist.albumCount }}
      {{ artist.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }}
    </div>
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import type { Artist } from '@/types/library'

export default {
  name: 'ArtistCard',
  components: { CoverArt },
  props: {
    artist: {
      type: Object as () => Artist,
      required: true,
    },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    async toggleStar() {
      await useLibraryStore().toggleStar({ artistId: this.artist.id, starred: this.artist.starred })
      // Prop mutation is intentional here — see AlbumCard.vue's identical
      // pattern and comment.
      // eslint-disable-next-line vue/no-mutating-props
      this.artist.starred = !this.artist.starred
    },
  },
}
</script>

<style scoped>
/* Same width as AlbumCard.vue's own .album-card, deliberately — the two
 * appear side by side (search results, the favorites view) and read as
 * mismatched at different sizes. The cover-art :size above matches it, so
 * both card types also come out the same height: cover + name + caption. */
.artist-card {
  width: 160px;
  cursor: pointer;
}

.artist-card-cover {
  position: relative;
  border-radius: 4px;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.artist-card:hover .artist-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.artist-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.artist-card:hover .artist-card-star {
  opacity: 1;
}

/* Amber, on nothing — same "amber means this is on" rule the rest of the
 * app follows. Both !importants undo this element's own resting style
 * above: the dark pill behind the icon exists to keep an *unstarred* heart
 * legible over artwork, and Vuetify paints `color` onto the background for
 * a flat button, so without clearing it the button stayed dark and the
 * heart never turned amber at all. */
.artist-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.artist-card:hover .artist-card-name {
  color: rgb(var(--v-theme-primary));
}
</style>
