<template>
  <section v-if="artists.length" class="similar-artists-shelf">
    <div class="similar-artists-shelf-head">
      <h2 class="section-title">{{ title }}</h2>
      <v-spacer />
      <div class="similar-artists-shelf-nav">
        <v-btn
          icon="mdi-chevron-left"
          variant="text"
          size="small"
          density="comfortable"
          @click="scrollRow(-1)"
        />
        <v-btn
          icon="mdi-chevron-right"
          variant="text"
          size="small"
          density="comfortable"
          @click="scrollRow(1)"
        />
      </div>
    </div>
    <!-- Same big-card language as AlbumCard.vue/ArtistCard.vue (160px cover
     - + name below), not the old small-pill row — a real Deezer photo when
     - HomeView.vue's lookup found one, plain fallback icon otherwise (no
     - cover-art placeholder to fall back to like an owned artist has —
     - CoverArt.vue's own coverArtId path never applies here, only
     - imageUrl). Links to the Deezer artist page when available — a real
     - page with music to browse, not just metadata — falling back to
     - MusicBrainz's own page (a real, deterministic URL for an MBID connect
     - just fetched *from* MusicBrainz itself) when Deezer has no match.
     - Either way, window.open() is intercepted by main/index.ts's
     - setWindowOpenHandler -> shell.openExternal, same as
     - ServerLoginView.vue's Plex sign-in link. -->
    <div ref="row" class="similar-artists-shelf-row">
      <a
        v-for="artist in artists"
        :key="artist.mbid"
        :href="artist.link"
        target="_blank"
        rel="noopener"
        class="similar-artists-card"
      >
        <cover-art
          :image-url="artist.imageUrl"
          :size="160"
          rounded
          fallback-icon="mdi-account-music"
          class="similar-artists-card-art"
        />
        <div class="similar-artists-card-name text-body-2 mt-2 text-truncate">
          {{ artist.name }}
        </div>
      </a>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { SimilarArtist } from '@/services/connect/recommendations'
import CoverArt from './CoverArt.vue'

/** SimilarArtist enriched with what HomeView.vue's own artist-images
 * lookup found (see discoverFromSimilarArtists()) — `link` always points
 * somewhere real (Deezer when found, MusicBrainz otherwise), never empty,
 * so this component never has to branch on which. */
export interface SimilarArtistDisplay extends SimilarArtist {
  imageUrl: string | null
  link: string
}

export default {
  name: 'SimilarArtistsShelf',
  components: { CoverArt },
  props: {
    title: {
      type: String,
      required: true,
    },
    artists: {
      type: Array as PropType<SimilarArtistDisplay[]>,
      required: true,
    },
  },
  methods: {
    // Same "scroll one row's worth" behavior as AlbumShelf.vue's own
    // scrollRow() — this shelf never uses AlbumShelf.vue's fitToScreen
    // mode (there's no reroll button here to fall back on, so it always
    // needs a scrollable pool instead of just truncating).
    scrollRow(direction: 1 | -1): void {
      const row = this.$refs.row as HTMLElement | undefined
      if (!row) return
      row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: 'smooth' })
    },
  },
}
</script>

<style scoped>
.similar-artists-shelf {
  margin-bottom: 40px;
}

.similar-artists-shelf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.similar-artists-shelf-nav {
  display: flex;
  gap: 4px;
}

.similar-artists-shelf-row {
  display: flex;
  gap: 20px;
  overflow-x: auto;
  padding-bottom: 4px;
  scroll-snap-type: x proximity;
}

.similar-artists-shelf-row > * {
  flex: 0 0 auto;
  scroll-snap-align: start;
}

.similar-artists-card {
  display: block;
  width: 160px;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}

.similar-artists-card-art {
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.similar-artists-card:hover .similar-artists-card-art {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.similar-artists-card:hover .similar-artists-card-name {
  color: rgb(var(--v-theme-primary));
}
</style>
