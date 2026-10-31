<template>
  <!-- AlbumCard.vue's shape for a single song: the cover plays it, the two
   - lines below lead to its album and artist. The song's own title links to
   - the album because a song has no page of its own. -->
  <div
    class="song-card"
    :class="{ 'song-card--row': row }"
    @click="row && play()"
    @contextmenu.prevent="openMenu"
  >
    <!-- One line of a chart (Home's most played): the whole line plays, and
     - the host puts a rank before it and a figure after it. The album is in
     - the menu, as the title is taken by the click. -->
    <template v-if="row">
      <span class="song-card-row__lead"><slot name="lead" /></span>
      <cover-art :cover-art-id="song.coverArtId" :size="40" class="song-card-row__cover" />
      <div class="song-card-row__text">
        <div class="song-card-row__title text-body-medium" :title="song.title">
          {{ song.title }}
        </div>
        <artist-credit
          :credit="song.artist"
          :artist-id="song.artistId"
          class="song-card-artist text-body-small text-medium-emphasis"
        />
      </div>
      <span class="song-card-row__figure text-body-small text-medium-emphasis">
        <slot name="figure" />
      </span>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="song.starred ? 'primary' : undefined"
        size="small"
        variant="text"
        class="song-card-row__star"
        :class="{ 'song-card-row__star--visible': song.starred }"
        :title="$t(song.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </template>
    <template v-else>
      <div class="song-card-cover" @click="play">
        <cover-art :cover-art-id="song.coverArtId" :size="160" />
        <div class="song-card-play-overlay">
          <v-icon icon="mdi-play-circle" size="40" />
        </div>
        <v-btn
          v-if="authStore.capabilities.favorites"
          :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'"
          :color="song.starred ? 'primary' : undefined"
          size="small"
          variant="flat"
          class="song-card-star"
          :class="{ 'song-card-star--visible': song.starred }"
          :title="$t(song.starred ? 'library.unstar' : 'library.star')"
          @click.stop="toggleStar"
        />
      </div>
      <router-link
        v-if="song.albumId"
        :to="`/albums/${song.albumId}`"
        class="song-card-title text-body-medium"
      >
        {{ song.title }}
      </router-link>
      <div v-else class="song-card-title text-body-medium">{{ song.title }}</div>
      <artist-credit
        :credit="song.artist"
        :artist-id="song.artistId"
        class="song-card-artist text-body-small text-medium-emphasis"
      />
    </template>
    <song-context-menu ref="menu" :song="song" />
  </div>
</template>

<script lang="ts">
import ArtistCredit from './ArtistCredit.vue'
import CoverArt from './CoverArt.vue'
import SongContextMenu from './SongContextMenu.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import type { Song } from '@/types/library'

export default {
  name: 'SongCard',
  components: {
    ArtistCredit,
    CoverArt,
    SongContextMenu,
  },
  props: {
    song: {
      type: Object as () => Song,
      required: true,
    },
    // One line of a list instead of a card - see the template.
    row: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      starring: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
    /** Just this song, the way a row in Home's top songs plays: the shelf
     * as a whole is what its own play button is for. */
    play(): void {
      void usePlaybackStore().playSongList([this.song], 0)
    },
    async toggleStar(): Promise<void> {
      if (this.starring) return
      this.starring = true
      try {
        await useLibraryStore().toggleFavorite('song', this.song)
      } finally {
        this.starring = false
      }
    },
  },
}
</script>

<style scoped>
/* AlbumCard.vue's card, rule for rule, so the two sit in the same kind of
 * row without looking like relatives. */
.song-card {
  width: 160px;
}

.song-card-cover {
  position: relative;
  border-radius: 4px;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.song-card:hover .song-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.song-card-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  background: rgba(11, 13, 19, 0.35);
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}

.song-card:hover .song-card-play-overlay {
  opacity: 1;
}

.song-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.song-card:hover .song-card-star {
  opacity: 1;
}

/* See AlbumCard.vue's identical rule. */
@media (hover: none) {
  .song-card-star,
  .song-card-play-overlay {
    opacity: 1;
  }
}

.song-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.song-card-title {
  display: block;
  margin-top: 8px;
  color: inherit;
  text-decoration: none;
}

.song-card:hover .song-card-title {
  color: rgb(var(--v-theme-primary));
}

.song-card-artist {
  display: block;
  width: fit-content;
  max-width: 100%;
  text-decoration: none;
}

.song-card-title,
.song-card-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* AlbumCard.vue's row geometry, with a rank in front. */
.song-card--row {
  width: 100%;
  height: 56px;
  display: grid;
  grid-template-columns: 24px 40px minmax(0, 1fr) auto 40px;
  align-items: center;
  gap: 14px;
  padding: 0 4px 0 8px;
  border-radius: 8px;
  cursor: pointer;
}

.song-card--row:hover {
  background: var(--beacon-hover);
}

.song-card-row__lead {
  display: flex;
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}

.song-card-row__text {
  min-width: 0;
}

.song-card-row__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.song-card--row:hover .song-card-row__title {
  color: rgb(var(--v-theme-primary));
}

.song-card-row__figure {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Shown on hover and once set, like AlbumCard.vue's row. */
.song-card-row__star {
  opacity: 0;
}

.song-card--row:hover .song-card-row__star,
.song-card-row__star--visible {
  opacity: 1;
}

@media (hover: none) {
  .song-card-row__star {
    opacity: 1;
  }
}
</style>
