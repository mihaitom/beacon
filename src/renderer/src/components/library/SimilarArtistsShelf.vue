<template>
  <!-- Same big-card language as AlbumCard.vue/ArtistCard.vue (160px cover +
   - name below), not the old small-pill row — a real Deezer photo when
   - homeShelves.ts's lookup found one, plain fallback icon otherwise (no
   - cover-art placeholder to fall back to like an owned artist has —
   - CoverArt.vue's own coverArtId path never applies here, only imageUrl).
   - The card itself isn't a link (unlike before) — there is no page in
   - this app to link an artist nobody owns to. What it does have is the
   - artwork click every other picture in the app has (see showArtwork()
   - below) and the icon row below the name, one per external service
   - homeShelves.ts's lookup found (same set, same icons, as
   - ArtistDetailView.vue shows for an owned artist —
   - see externalArtistLinks.ts), instead of picking a single destination
   - (Deezer, or MusicBrainz as a fallback) on the artist's behalf.
   - window.open() is intercepted by main/index.ts's setWindowOpenHandler ->
   - shell.openExternal, same as ServerLoginView.vue's Plex sign-in link. -->
  <card-shelf v-if="artists.length || loading" ref="shelf" :title="title">
    <!-- Passed straight through to CardShelf's own header slot: this shelf
     - is filled by the same request that fills the Discover one (see
     - homeShelves.ts's discoverFromSimilarArtists), so the control for
     - asking again belongs beside both of them, not just beside one. -->
    <template #action><slot name="action" /></template>
    <!-- Placeholder cards matching the real ones' shape, so asking for a
     - different set doesn't collapse the shelf to nothing and push the rest
     - of the page up while the lookup runs — the same reason AlbumShelf.vue
     - has its own. -->
    <template v-if="loading">
      <div v-for="n in skeletonCount" :key="`skeleton-${n}`" class="similar-artists-card">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded" />
        <v-skeleton-loader type="text" width="70%" height="20" class="similar-skeleton__label" />
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
      <div class="similar-artists-card-art-wrap">
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
        <!-- The artist's top tracks as previews, the way an album's
         - Preview button plays an album. Beside the photo, not on it: the
         - photo is a button of its own. -->
        <v-btn
          :icon="previewIcon(artist)"
          :color="isPreviewing(artist) ? 'primary' : undefined"
          :loading="previewLoading === artist.mbid"
          :disabled="!previewAvailable || noPreview.includes(artist.mbid)"
          :title="previewLabel(artist)"
          :aria-label="previewLabel(artist)"
          size="small"
          variant="flat"
          class="similar-artists-card-preview"
          :class="{ 'similar-artists-card-preview--visible': isPreviewing(artist) }"
          @click="togglePreview(artist)"
        />
      </div>
      <div class="similar-artists-card-name text-body-medium">
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
import { getDeezerTracks } from '@/services/connect/deezer'
import { deezerPreviewSong, PREVIEW_SONGS } from '@/services/playback/preview'
import { previewHeardByGuests } from '@/services/playback/previewAvailability'
import { usePlaybackStore } from '@/stores/playback'
import { toExternalLinkList, type ExternalLinkKey } from '@/components/library/externalArtistLinks'
import CoverArt from './CoverArt.vue'
import CardShelf from './CardShelf.vue'
import { observeCardsAcross, skeletonsAcross } from './cardRowFit'

/** SimilarArtist enriched with what homeShelves.ts's own artist-images +
 * artist-links-by-mbid lookups found (see discoverFromSimilarArtists()) —
 * `links` always has at least a musicbrainz entry (homeShelves.ts's own
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
      skeletonCount: 15,
      resizeObserver: null as ResizeObserver | null,
      /** The mbid of the card whose top tracks are being fetched. */
      previewLoading: '',
      /** Which song each card's preview started with, so its button can
       * tell whether the preview playing is its own. */
      previewSongIds: {} as Record<string, string>,
      /** Cards Deezer has no top tracks for, so their button says so. */
      noPreview: [] as string[],
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
  computed: {
    /** Not while guests listening along to a party would hear it - the
     * same rule as an album's Preview button. */
    previewAvailable(): boolean {
      return !previewHeardByGuests()
    },
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
  methods: {
    isPreviewing(artist: SimilarArtistDisplay): boolean {
      const playback = usePlaybackStore()
      const id = this.previewSongIds[artist.mbid]
      return !!id && playback.preview?.songs[0]?.id === id
    },
    previewIcon(artist: SimilarArtistDisplay): string {
      if (this.noPreview.includes(artist.mbid)) return 'mdi-music-note-off'
      return this.isPreviewing(artist) ? 'mdi-stop' : 'mdi-headphones'
    },
    previewLabel(artist: SimilarArtistDisplay): string {
      if (this.noPreview.includes(artist.mbid)) return this.$t('builder.noPreview')
      return this.isPreviewing(artist)
        ? this.$t('builder.stopPreview')
        : this.$t('home.previewTopSongs')
    },
    /** Plays the artist's top tracks on Deezer, 30 seconds each, as one
     * preview (the store's startTracksPreview()). A second click stops it.
     * A failed lookup leaves the button as it was, to be tried again;
     * only an empty answer marks the card. */
    async togglePreview(artist: SimilarArtistDisplay): Promise<void> {
      const playback = usePlaybackStore()
      if (this.isPreviewing(artist)) {
        playback.endPreview()
        return
      }
      if (this.previewLoading) return
      this.previewLoading = artist.mbid
      try {
        const tracks = await getDeezerTracks({
          op: 'artist',
          artist: artist.name,
          limit: PREVIEW_SONGS,
        })
        const songs = tracks
          .filter((track) => track.deezerId)
          .map((track) => deezerPreviewSong(track.deezerId, track))
        if (!songs.length) {
          this.noPreview.push(artist.mbid)
          return
        }
        this.previewSongIds[artist.mbid] = songs[0]!.id
        await playback.startTracksPreview(songs)
      } catch (error) {
        console.error('[home] Artist preview failed:', error)
      } finally {
        this.previewLoading = ''
      }
    },
    externalLinks(urls: Partial<Record<ExternalLinkKey, string>>) {
      return toExternalLinkList(urls)
    },
    showArtwork(artist: SimilarArtistDisplay): void {
      emitter.emit('showArtwork', {
        // No coverArtId to offer: these artists are not in the library,
        // which is the whole point of the shelf. The photo is whatever
        // homeShelves.ts's own lookup found — at the larger size here, since
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

/* The lift moves the wrap, so the preview button rises with the photo. */
.similar-artists-card-art-wrap {
  position: relative;
  transition: transform 0.15s ease;
}

.similar-artists-card:hover .similar-artists-card-art-wrap {
  transform: translateY(-3px);
}

/* Like the album card's heart: in the corner, shown on hover, and always
 * while its own preview plays. */
.similar-artists-card-preview {
  position: absolute;
  right: 6px;
  bottom: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.similar-artists-card-preview:not(.similar-artists-card-preview--visible) {
  background: rgba(11, 13, 19, 0.75) !important;
}

.similar-artists-card:hover .similar-artists-card-preview,
.similar-artists-card-preview:focus-visible,
.similar-artists-card-preview--visible {
  opacity: 1;
}

/* No hover to reveal it with on a touch screen. */
@media (hover: none) {
  .similar-artists-card-preview {
    opacity: 1;
  }
}

.similar-artists-card-art {
  transition: box-shadow 0.15s ease;
}

.similar-artists-card:hover .similar-artists-card-art {
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
  background-color: var(--beacon-hover);
}

.similar-artists-card-link-icon {
  width: 12px;
  height: 12px;
  object-fit: contain;
}

.similar-artists-card-link-icon--invert {
  filter: invert(1);
}

/* An artist's name under a small round photo. */
.similar-artists-card-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.similar-artists-card-name {
  margin-top: 8px;
}

/* Same gap as .similar-artists-card-name, centred like the real one. */
.similar-skeleton__label {
  margin-top: 8px;
  margin-inline: auto;
}
</style>
