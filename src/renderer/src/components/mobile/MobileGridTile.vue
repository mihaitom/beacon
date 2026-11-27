<template>
  <component :is="cardLink ? 'router-link' : 'div'" v-bind="rootAttrs" class="mobile-grid-tile">
    <!-- The desktop's cards (SongCard.vue, AlbumCard.vue, ArtistCard.vue) at
       - the width of a phone's grid column, rule for rule where the two can
       - agree: a 4px cover, the heart on it, name over a quieter second line.
       - What differs is where a tap leads - the phone's own pages - and that
       - there is no hover, so what the desktop reveals on it is simply on. -->
    <component
      :is="kind === 'song' ? 'button' : 'span'"
      v-bind="coverAttrs"
      class="mobile-grid-tile__cover"
    >
      <cover-art
        :cover-art-id="item.coverArtId"
        :image-url="kind === 'artist' ? (item as Artist).imageUrl : null"
        size="100%"
        :fetch-as="TILE_FETCH_SIZE"
        :fallback-icon="fallbackIcon"
      />
      <!-- A song's cover plays it, as on the desktop; the overlay is what
         - says so. -->
      <span v-if="kind === 'song'" class="mobile-grid-tile__play" aria-hidden="true">
        <v-icon icon="mdi-play-circle" size="40" />
      </span>
      <v-btn
        v-if="canStar"
        :icon="item.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="item.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="mobile-grid-tile__star"
        :class="{ 'mobile-grid-tile__star--on': item.starred }"
        :title="$t(item.starred ? 'library.unstar' : 'library.star')"
        @click.prevent.stop="toggleStar"
      />
    </component>

    <!-- A song has no page of its own; its title leads to its album, the
       - desktop card's choice too. -->
    <router-link
      v-if="kind === 'song' && (item as Song).albumId"
      :to="`/m/albums/${(item as Song).albumId}`"
      class="mobile-grid-tile__title text-body-medium"
    >
      {{ title }}
    </router-link>
    <span v-else class="mobile-grid-tile__title text-body-medium">{{ title }}</span>

    <span
      v-if="kind === 'artist'"
      class="mobile-grid-tile__meta mobile-grid-tile__counts text-body-small text-medium-emphasis"
    >
      <span class="mobile-grid-tile__count">
        <v-icon icon="mdi-album" size="13" />
        {{ $n((item as Artist).albumCount) }}
      </span>
      <!-- Only once the catalogue it is counted from has arrived, as on the
         - desktop: a 0 there would be wrong rather than merely absent. -->
      <span v-if="songCount !== null" class="mobile-grid-tile__count">
        <v-icon icon="mdi-music-note" size="13" />
        {{ $n(songCount) }}
      </span>
      <!-- What the list is sorted by, at the line's far end. -->
      <span v-if="detail" class="mobile-grid-tile__detail">{{ detail }}</span>
    </span>
    <span
      v-else
      class="mobile-split-line mobile-grid-tile__meta text-body-small text-medium-emphasis"
    >
      <span>{{ (item as Song | Album).artist }}</span>
      <span v-if="detail">{{ detail }}</span>
    </span>
  </component>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import type { Album, Artist, Song } from '@/types/library'

/** A tile is at most a third of a tablet held upright; 300px covers that at
 * twice the pixel density without fetching the 640 tier for every tile. */
const TILE_FETCH_SIZE = 300

type Kind = 'song' | 'album' | 'artist'

export default {
  name: 'MobileGridTile',
  components: { CoverArt },
  props: {
    kind: { type: String as PropType<Kind>, required: true },
    item: { type: Object as PropType<Song | Album | Artist>, required: true },
    /** An artist's songs in the library, null until they are counted. */
    songCount: { type: Number as PropType<number | null>, default: null },
    /** What the list is sorted by, after the second line's own text (see
     * libraryBrowse.ts's sortDetail()). */
    detail: { type: String as PropType<string | null>, default: null },
  },
  emits: ['play'],
  data() {
    return { TILE_FETCH_SIZE, starring: false }
  },
  computed: {
    title(): string {
      return this.kind === 'song' ? (this.item as Song).title : (this.item as Album | Artist).name
    },
    fallbackIcon(): string {
      if (this.kind === 'artist') return 'mdi-account-music'
      return this.kind === 'album' ? 'mdi-album' : 'mdi-music-note'
    },
    /** Albums and artists open on a tap anywhere, like their desktop cards. */
    cardLink(): string | null {
      if (this.kind === 'album') return `/m/albums/${this.item.id}`
      if (this.kind === 'artist') return `/m/artists/${this.item.id}`
      return null
    },
    rootAttrs(): Record<string, unknown> {
      return this.cardLink ? { to: this.cardLink } : {}
    },
    coverAttrs(): Record<string, unknown> {
      if (this.kind !== 'song') return {}
      return {
        type: 'button',
        'aria-label': `${this.$t('library.play')}: ${this.title}`,
        onClick: () => this.$emit('play'),
      }
    },
    canStar(): boolean {
      return useAuthStore().capabilities.favorites
    },
  },
  methods: {
    async toggleStar() {
      if (this.starring) return
      this.starring = true
      try {
        await useLibraryStore().toggleFavorite(this.kind, this.item)
      } finally {
        this.starring = false
      }
    },
  },
}
</script>

<style scoped>
.mobile-grid-tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.mobile-grid-tile__cover {
  position: relative;
  display: block;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 4px;
  padding: 0;
}

.mobile-grid-tile__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  background: rgba(11, 13, 19, 0.35);
  pointer-events: none;
}

.mobile-grid-tile__star {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(11, 13, 19, 0.75) !important;
}

.mobile-grid-tile__star--on {
  background: transparent !important;
}

.mobile-grid-tile__title {
  display: block;
  margin-top: 8px;
  color: inherit;
  text-decoration: none;
}

.mobile-grid-tile__title,
.mobile-grid-tile__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-grid-tile__counts {
  display: flex;
  gap: 10px;
}

.mobile-grid-tile__detail {
  margin-left: auto;
  flex-shrink: 0;
}

.mobile-grid-tile__count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
</style>
