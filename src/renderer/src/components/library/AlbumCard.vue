<template>
  <div class="album-card" @click="$router.push(`/albums/${album.id}`)">
    <div class="album-card-cover">
      <cover-art :cover-art-id="album.coverArtId" :size="160" />
      <v-btn
        :icon="album.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="album.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="album-card-star"
        :class="{ 'album-card-star--visible': album.starred }"
        :title="$t(album.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </div>
    <div class="album-card-title text-body-2 mt-2 text-truncate">{{ album.name }}</div>
    <div class="album-card-artist text-caption text-medium-emphasis text-truncate">
      {{ album.artist }}
    </div>
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import type { Album } from '@/types/library'

export default {
  name: 'AlbumCard',
  components: { CoverArt },
  props: {
    album: {
      type: Object as () => Album,
      required: true,
    },
  },
  methods: {
    async toggleStar() {
      await useLibraryStore().toggleStar({ albumId: this.album.id, starred: this.album.starred })
      // Prop mutation is intentional here — the store's own toggleStar()
      // updates a separate favorites-list slice, not this album's own
      // `starred` field (returned per-item by getAlbumList2.view), so this
      // is the only place that can give immediate optimistic UI feedback —
      // same "caller owns optimistic local state" pattern library.ts's
      // setRating() documents.
      // eslint-disable-next-line vue/no-mutating-props
      this.album.starred = !this.album.starred
    },
  },
}
</script>

<style scoped>
.album-card {
  width: 160px;
  cursor: pointer;
}

.album-card-cover {
  position: relative;
  border-radius: 4px;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.album-card:hover .album-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.album-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.album-card:hover .album-card-star,
.album-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.album-card:hover .album-card-title {
  color: rgb(var(--v-theme-primary));
}
</style>
