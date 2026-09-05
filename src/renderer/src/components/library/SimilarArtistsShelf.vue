<template>
  <!-- Same big-card language as AlbumCard.vue/ArtistCard.vue (160px cover +
   - name below), not the old small-pill row — a real Deezer photo when
   - HomeView.vue's lookup found one, plain fallback icon otherwise (no
   - cover-art placeholder to fall back to like an owned artist has —
   - CoverArt.vue's own coverArtId path never applies here, only imageUrl).
   - The card itself isn't a link (unlike before) — there is no page in
   - this app to link an artist nobody owns to. What it does have is the
   - artwork click every other picture in the app has (see showArtwork()
   - below) and the icon row below the name, one per external service
   - HomeView.vue's lookup found (same set, same icons, as
   - ArtistDetailView.vue shows for an owned artist —
   - see externalArtistLinks.ts), instead of picking a single destination
   - (Deezer, or MusicBrainz as a fallback) on the artist's behalf.
   - window.open() is intercepted by main/index.ts's setWindowOpenHandler ->
   - shell.openExternal, same as ServerLoginView.vue's Plex sign-in link. -->
  <card-shelf v-if="artists.length || loading" ref="shelf" :title="title">
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
      <div v-for="n in skeletonCount" :key="`skeleton-${n}`" class="similar-artists-card">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded" />
        <v-skeleton-loader type="text" width="70%" height="20" class="mt-2 mx-auto" />
        <!-- Stands in for the row of service links, not for a second line
         - of text: 18px icons with the 6px of space above them the real
         - row has (see .similar-artists-card-links). -->
        <v-skeleton-loader type="text" width="45%" height="18" class="mx-auto skeleton-links" />
      </div>
    </template>
    <div v-for="artist in loading ? [] : artists" :key="artist.mbid" class="similar-artists-card">
      <!-- Clicking the photo opens it full size, the same thing clicking
         - artwork does on every detail page and in the tile menus. These
         - cards are the one place with artwork and no other left-click
         - meaning of its own (the card deliberately isn't a link — see the
         - comment at the top), so the viewer gets it rather than nothing
         - happening. A plain <div> for an artist with no photo at all:
         - there would be nothing to open but the fallback icon. -->
      <button
        v-if="artist.imageUrl"
        type="button"
        class="similar-artists-card-art-button"
        :title="$t('library.showArtwork')"
        @click="showArtwork(artist)"
      >
        <cover-art
          :image-url="artist.imageUrl"
          :size="160"
          rounded
          fallback-icon="mdi-account-music"
          class="similar-artists-card-art"
        />
      </button>
      <cover-art
        v-else
        :image-url="artist.imageUrl"
        :size="160"
        rounded
        fallback-icon="mdi-account-music"
        class="similar-artists-card-art"
      />
      <div class="similar-artists-card-name text-body-medium mt-2 text-truncate">
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
import { emitter } from '@/emitter'
import type { SimilarArtist } from '@/services/connect/recommendations'
import { toExternalLinkList, type ExternalLinkKey } from '@/components/library/externalArtistLinks'
import CoverArt from './CoverArt.vue'
import CardShelf from './CardShelf.vue'
import { observeCardsAcross, skeletonsAcross } from './cardRowFit'

/** SimilarArtist enriched with what HomeView.vue's own artist-images +
 * artist-links-by-mbid lookups found (see discoverFromSimilarArtists()) —
 * `links` always has at least a musicbrainz entry (HomeView.vue's own
 * last-resort fallback when nothing else came back), so this component
 * never has to handle a totally-empty card. */
export interface SimilarArtistDisplay extends SimilarArtist {
  imageUrl: string | null
  /** The same photo, big enough for the artwork viewer — see ArtistImage's
   * own note on why the card does not simply use this one. */
  largeImageUrl: string | null
  links: Partial<Record<ExternalLinkKey, string>>
}

export default {
  name: 'SimilarArtistsShelf',
  components: { CoverArt, CardShelf },
  data() {
    return {
      // Measured rather than fixed, so the placeholders fill whatever
      // window this is open in — see cardRowFit.ts. This shelf and the
      // Discover album shelf next to it are the two that take long enough
      // to load for anyone to see them, which is why a count that only
      // looked right on a narrow window showed up here first.
      skeletonCount: 6,
      resizeObserver: null as ResizeObserver | null,
    }
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
  mounted() {
    // The row, not this component's own $el: the template leads with a
    // comment, which makes this a fragment whose $el is that comment node.
    const row = (this.$refs.shelf as InstanceType<typeof CardShelf> | undefined)?.rowElement()
    if (!row) return
    this.resizeObserver = observeCardsAcross(row, (width) => {
      this.skeletonCount = skeletonsAcross(width)
    })
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
  methods: {
    externalLinks(urls: Partial<Record<ExternalLinkKey, string>>) {
      return toExternalLinkList(urls)
    },
    showArtwork(artist: SimilarArtistDisplay): void {
      emitter.emit('showArtwork', {
        // No coverArtId to offer: these artists are not in the library,
        // which is the whole point of the shelf. The photo is whatever
        // HomeView.vue's own lookup found — at the larger size here, since
        // the viewer fills most of the window and the card's own 250px
        // looked like 250px blown up. Falls back to the card's picture for
        // an artist whose lookup only produced the one.
        imageUrl: artist.largeImageUrl ?? artist.imageUrl,
        // Already on screen in the card that was just clicked, so it fills
        // the viewer instantly while the large one downloads instead of a
        // skeleton appearing over a picture the person could already see.
        placeholderImageUrl: artist.imageUrl,
        title: artist.name,
        // Matches how the card itself renders it (CoverArt's rounded
        // branch), so the picture does not change shape on the way into
        // the viewer.
        rounded: true,
        fallbackIcon: 'mdi-account-music',
      })
    },
  },
}
</script>

<style scoped>
.similar-artists-card {
  width: 160px;
}

/* Same reason AlbumShelf.vue and AlbumsView.vue force this: a
 * v-skeleton-loader's bones ignore the component's own width/height props
 * (those size the outer wrapper only) and keep fixed CSS heights plus a
 * 16px margin of their own. Without it this shelf's placeholders were the
 * one set in the app that didn't match the cards they stand in for, and
 * the row changed height as the artists arrived. */
.similar-artists-card :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

/* The links row sits 6px below the name (see .similar-artists-card-links),
 * which the placeholder above stands in for. */
.similar-artists-card .skeleton-links {
  margin-top: 6px;
}

/* Stripped back to the artwork it wraps — a button for the keyboard and
 * for what a click means, not for how it looks.
 *
 * zoom-in rather than a plain pointer: artwork that opens full size says
 * so with the magnifier everywhere else it happens (DetailHeader.vue's own
 * .detail-header__cover--zoomable), and the viewer it opens answers with
 * zoom-out. A pointer here would read as "this goes somewhere", which is
 * the one thing this card deliberately does not do. */
.similar-artists-card-art-button {
  display: block;
  appearance: none;
  border: 0;
  padding: 0;
  background: none;
  cursor: zoom-in;
}

.similar-artists-card-art-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
  border-radius: 4px;
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
