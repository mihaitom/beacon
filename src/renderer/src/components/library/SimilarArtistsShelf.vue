<template>
  <!-- Same big-card language as AlbumCard.vue/ArtistCard.vue (160px cover +
   - name below), not the old small-pill row — a real Deezer photo when
   - HomeView.vue's lookup found one, plain fallback icon otherwise (no
   - cover-art placeholder to fall back to like an owned artist has —
   - CoverArt.vue's own coverArtId path never applies here, only imageUrl).
   - The card itself isn't a link (unlike before) — the icon row below the
   - name is, one per external service HomeView.vue's lookup found (same
   - set, same icons, as ArtistDetailView.vue shows for an owned artist —
   - see externalArtistLinks.ts), instead of picking a single destination
   - (Deezer, or MusicBrainz as a fallback) on the artist's behalf.
   - window.open() is intercepted by main/index.ts's setWindowOpenHandler ->
   - shell.openExternal, same as ServerLoginView.vue's Plex sign-in link. -->
  <card-shelf v-if="artists.length || loading" :title="title">
    <!-- Passed straight through to CardShelf's own header slot: this shelf
     - is filled by the same request that fills the Discover one (see
     - HomeView.vue's discoverFromSimilarArtists), so the control for
     - asking again belongs beside both of them, not just beside one. -->
    <template #action><slot name="action" /></template>
    <!-- Placeholder cards matching the real ones' shape, so asking for a
     - different set doesn't collapse the shelf to nothing and push the rest
     - of the page up while the lookup runs — the same reason AlbumShelf.vue
     - has its own. -->
    <template v-if="loading">
      <div v-for="n in SKELETON_COUNT" :key="`skeleton-${n}`" class="similar-artists-card">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded" />
        <v-skeleton-loader type="text" width="80%" height="20" class="mt-2" />
        <v-skeleton-loader type="text" width="45%" height="16" />
      </div>
    </template>
    <div v-for="artist in loading ? [] : artists" :key="artist.mbid" class="similar-artists-card">
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
      <div class="similar-artists-card-links">
        <a
          v-for="link in externalLinks(artist.links)"
          :key="link.key"
          :href="link.url"
          target="_blank"
          rel="noopener"
          class="similar-artists-card-link"
          :title="$t('library.viewOnService', { service: link.name })"
        >
          <img
            :src="link.icon"
            :alt="link.name"
            class="similar-artists-card-link-icon"
            :class="{ 'similar-artists-card-link-icon--invert': link.invert }"
          />
        </a>
      </div>
    </div>
  </card-shelf>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { SimilarArtist } from '@/services/connect/recommendations'
import { toExternalLinkList, type ExternalLinkKey } from '@/components/library/externalArtistLinks'
import CoverArt from './CoverArt.vue'
import CardShelf from './CardShelf.vue'

/** SimilarArtist enriched with what HomeView.vue's own artist-images +
 * artist-links-by-mbid lookups found (see discoverFromSimilarArtists()) —
 * `links` always has at least a musicbrainz entry (HomeView.vue's own
 * last-resort fallback when nothing else came back), so this component
 * never has to handle a totally-empty card. */
export interface SimilarArtistDisplay extends SimilarArtist {
  imageUrl: string | null
  links: Partial<Record<ExternalLinkKey, string>>
}

// Enough to fill a row on a normal window without measuring anything —
// the shelf scrolls horizontally, so overshooting costs nothing but a few
// placeholders scrolled off the right edge.
const SKELETON_COUNT = 8

export default {
  name: 'SimilarArtistsShelf',
  components: { CoverArt, CardShelf },
  computed: {
    SKELETON_COUNT: () => SKELETON_COUNT,
  },
  props: {
    title: {
      type: String,
      required: true,
    },
    loading: {
      type: Boolean,
      default: false,
    },
    artists: {
      type: Array as PropType<SimilarArtistDisplay[]>,
      required: true,
    },
  },
  methods: {
    externalLinks(urls: Partial<Record<ExternalLinkKey, string>>) {
      return toExternalLinkList(urls)
    },
  },
}
</script>

<style scoped>
.similar-artists-card {
  width: 160px;
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

/* Centered, not left-aligned under the art like AlbumCard.vue's own title
 * — a name alone reads fine flush-left, but with the links row right
 * beneath it (also centered, see below), a left-aligned name over a
 * centered icon row looked lopsided. */
.similar-artists-card-name {
  text-align: center;
}

.similar-artists-card-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 3px;
  margin-top: 6px;
}

/* Sized so all seven possible services (see externalArtistLinks.ts) fit on
 * one row within the card's own 160px — 7 * (18px circle + 3px gap) =
 * 147px, comfortable margin without wrapping to a second row in the
 * common case. flex-wrap above stays as a safety net regardless (a future
 * eighth service, or a genuinely narrower card elsewhere), not depended on
 * for the normal case. */
.similar-artists-card-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  opacity: 0.7;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease;
}

.similar-artists-card-link:hover {
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.08);
}

.similar-artists-card-link-icon {
  width: 12px;
  height: 12px;
  object-fit: contain;
}

.similar-artists-card-link-icon--invert {
  filter: invert(1);
}
</style>
