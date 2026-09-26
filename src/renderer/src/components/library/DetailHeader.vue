<template>
  <section
    ref="card"
    class="detail-header"
    :class="{ 'detail-header--text-only': !hasArtwork }"
    :style="textEnd ? { '--text-end': `${textEnd}px` } : {}"
  >
    <!-- Two stacked layers so navigating from one album/artist to the next
     - crossfades the artwork behind the header instead of cutting to it —
     - see services/crossfadeBackdrop.ts for why one element can't do this. -->
    <div
      v-for="(url, i) in backdrop.urls"
      :key="i"
      class="detail-header__backdrop"
      :class="{
        'detail-header__backdrop--active': i === backdrop.active,
        'detail-header__backdrop--photo': layerKind[i] === 'photo',
        'detail-header__backdrop--banner': layerKind[i] === 'banner',
      }"
      :style="layerStyle(url, i)"
    >
      <div v-if="layerKind[i] !== 'cover'" class="detail-header__backdrop-slot">
        <!-- A stored picture opens its artist's page, when the library has
         - them - a shortcut only, so no keyboard stop of its own. -->
        <div
          class="detail-header__backdrop-art"
          :class="{ 'detail-header__backdrop-art--link': i === backdrop.active && activeArtist }"
          :title="
            i === backdrop.active && activeArtist
              ? `${$t('library.goToArtist')}: ${activeArtist.name}`
              : undefined
          "
          @click="openArtist(i)"
        />
      </div>
    </div>
    <div
      class="detail-header__scrim"
      :class="{ 'detail-header__scrim--photo': layerKind[backdrop.active] !== 'cover' }"
    />
    <div v-if="starred !== null || $slots['top-right']" class="detail-header__top-right">
      <!-- Its own row, separate from the #top-right slot below — rating/
       - heart are icon-sized controls that always belong together on one
       - line; slot content (an artist page's external-link icons, a
       - playlist's edit/delete buttons) is a different, often wider group
       - that reads better stacked under them than crammed onto the same
       - line. v-if guards it so an empty row (e.g. a playlist, which has
       - neither) doesn't reserve a gap for nothing. -->
      <div v-if="rating !== null || starred !== null" class="detail-header__top-right-row">
        <v-rating
          v-if="rating !== null"
          :model-value="rating"
          length="5"
          size="large"
          density="compact"
          active-color="primary"
          hover
          clearable
          class="detail-header__rating"
          @update:model-value="$emit('set-rating', $event)"
        />
        <v-btn
          v-if="starred !== null"
          :icon="starred ? 'mdi-heart' : 'mdi-heart-outline'"
          :color="starred ? 'primary' : undefined"
          variant="text"
          :title="$t(starred ? 'library.unstar' : 'library.star')"
          @click="$emit('toggle-star')"
        />
      </div>
      <div v-if="$slots['top-right']" class="detail-header__top-right-row">
        <slot name="top-right" />
      </div>
    </div>
    <div ref="text" class="detail-header__content">
      <!-- Only when there is a real picture: a list page has none, and a
       - square holding nothing but a generic icon takes room from the
       - title without saying anything. The icon remains for a picture that
       - fails to load. -->
      <cover-art
        v-if="hasArtwork"
        :cover-art-id="coverArtId"
        :image-url="imageUrl"
        :size="size"
        :fallback-icon="fallbackIcon"
        :rounded="rounded"
        class="detail-header__cover detail-header__cover--zoomable cover-shadow"
        :title="$t('library.showArtwork')"
        @click="showArtwork"
      />
      <div class="detail-header__info min-width-0">
        <div v-if="eyebrow" class="eyebrow-label detail-header__eyebrow">{{ eyebrow }}</div>
        <h1 class="detail-title detail-header__title">{{ title }}</h1>
        <div v-if="$slots.subtitle" class="detail-header__subtitle">
          <slot name="subtitle" />
        </div>
        <div v-if="$slots.meta" class="detail-header__meta">
          <slot name="meta" />
        </div>
        <slot name="description" />
        <div v-if="$slots.actions" class="detail-header__actions">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { emitter } from '@/emitter'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { type EdgeGradients, extractEdgeGradients } from '@/services/edgeFill'
import { textEnd } from '@/services/textExtent'
import { getStoredImages, type StoredImage } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'
import type { Artist } from '@/types/library'

// How long each stored Fanart.tv background stays before the next one fades
// in - slow enough to read as a calm backdrop rather than a slideshow.
const STORED_FANART_INTERVAL_MS = 12_000

/** A stored Fanart.tv banner across the whole card, a stored background
 * photo at its right edge, or the page's own blurred cover. */
type BackdropKind = 'banner' | 'photo' | 'cover'

/**
 * Shared "hero" treatment for album/artist/playlist detail pages — a
 * blurred, tinted wash of the item's own art behind the title, the same
 * language HeroBand.vue/NowPlayingView.vue already use elsewhere. Exists
 * specifically to replace the plain "square cover + text beside it" row
 * every detail view used before.
 */
export default {
  name: 'DetailHeader',
  components: { CoverArt },
  props: {
    coverArtId: { type: String as PropType<string | null>, default: null },
    imageUrl: { type: String as PropType<string | null>, default: null },
    size: { type: Number, default: 180 },
    // Optional — omitted on plain browse/list pages (AlbumsView.vue etc.)
    // where the only candidate text was the same word as `title`, just
    // singular ("Album" over "Albums") — pure noise, not information.
    // Still required-in-spirit for detail pages (AlbumDetailView.vue etc.),
    // which pass a real category label above the item's own name.
    eyebrow: { type: String, default: '' },
    title: { type: String, required: true },
    fallbackIcon: { type: String, default: 'mdi-album' },
    rounded: { type: Boolean, default: false },
    // null hides the star button entirely (e.g. playlists, which Subsonic
    // has no starred concept for) — true/false shows it in that state.
    starred: { type: Boolean as PropType<boolean | null>, default: null },
    // null hides the rating widget entirely (e.g. playlists) — 0-5 shows it,
    // 0 meaning "not yet rated" rather than "rated zero stars".
    rating: { type: Number as PropType<number | null>, default: null },
    /** For a list page with no picture of its own: cycle through the Fanart.tv
     * banners (or, until there are some, backgrounds) connect has already
     * stored - every artist's (true), or only these artists' (a genre's).
     * Nothing new is downloaded for it. */
    storedFanart: { type: [Boolean, Array] as PropType<boolean | string[]>, default: false },
  },
  emits: ['toggle-star', 'set-rating'],
  data() {
    return {
      backdrop: createBackdropLayers(),
      // Per layer, since Fanart.tv art is shown sharp and a cover blurred.
      layerKind: ['cover', 'cover'] as BackdropKind[],
      /** Per layer: its Fanart.tv art's edge colours, continued beside it. */
      fills: [null, null] as (EdgeGradients | null)[],
      /** Per layer: the names of the artist its stored picture is of. */
      layerArtists: [[], []] as string[][],
      /** Where the text ends, in px from the left: the art is faded out
       * up to there (see measureText). */
      textEnd: 0,
      textObserver: null as ResizeObserver | null,
      photos: [] as StoredImage[],
      photoKind: 'banner' as BackdropKind,
      photoIndex: 0,
      cycleTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    /** What storedFanart asks for, as one value to watch: null for nothing,
     * [] for every artist, or the artists' names. */
    storedFanartRequest(): string[] | null {
      if (!useFanartStore().enabled || this.backdropUrl) return null
      if (this.storedFanart === true) return []
      return Array.isArray(this.storedFanart) && this.storedFanart.length ? this.storedFanart : null
    },
    backdropUrl(): string | null {
      if (this.coverArtId) return useLibraryStore().client().coverArtUrl(this.coverArtId, 300)
      return this.imageUrl
    },
    hasArtwork(): boolean {
      return Boolean(this.coverArtId || this.imageUrl)
    },
    /** The library's artist the stored picture showing now is of, if the
     * library has them. */
    activeArtist(): Artist | null {
      const names = this.layerArtists[this.backdrop.active] ?? []
      if (!names.length) return null
      const wanted = names.map((name) => name.trim().toLowerCase())
      const artists = useLibraryStore().artists
      for (const name of wanted) {
        const match = artists.find((artist) => artist.name.trim().toLowerCase() === name)
        if (match) return match
      }
      return null
    },
  },
  methods: {
    measureText(): void {
      const card = this.$refs.card as HTMLElement | undefined
      const text = this.$refs.text as HTMLElement | undefined
      if (card && text) this.textEnd = Math.round(textEnd(text, card))
    },
    show(url: string | null, kind: BackdropKind, artists: string[] = []): void {
      showBackdrop(this.backdrop, url)
      this.layerKind[this.backdrop.active] = kind
      this.layerArtists[this.backdrop.active] = artists
      void this.paintFill(this.backdrop.active, url, kind)
    },
    /** Paints layer `index`'s edge fill for Fanart.tv art, once its
     * colours are read - unless the layer has moved on to another picture
     * meanwhile. */
    async paintFill(index: number, url: string | null, kind: BackdropKind): Promise<void> {
      this.fills[index] = null
      if (!url || kind === 'cover') return
      const gradients = await extractEdgeGradients(url)
      if (this.backdrop.urls[index] === url) this.fills[index] = gradients
    },
    layerStyle(url: string | null, index: number): Record<string, string> {
      const fill = this.fills[index]
      return {
        ...(url ? { '--backdrop-image': `url(${url})` } : {}),
        ...(fill ? { '--fill-left': fill.left, '--fill-right': fill.right } : {}),
      }
    },
    async loadStoredFanart(request: string[] | null): Promise<void> {
      this.stopCycle()
      this.photos = []
      if (!request) {
        if (!this.backdropUrl) this.show(null, 'cover')
        return
      }
      const stored = await this.fetchStored(request)
      // The page may have moved on, or found a picture of its own, meanwhile.
      if (JSON.stringify(this.storedFanartRequest) !== JSON.stringify(request)) return
      if (!stored.photos.length) return
      // To tell whose picture is showing; usually loaded already.
      useLibraryStore()
        .fetchArtists()
        .catch((error) => console.error('[detail-header] Artists lookup failed:', error))
      this.photos = stored.photos
      this.photoKind = stored.kind
      // Already shuffled by connect, one artist at a time - see stored_images().
      this.photoIndex = 0
      await this.showPhoto(stored.photos[0]!)
      // One picture and no cycling for anyone who has asked for less motion.
      if (
        stored.photos.length < 2 ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return
      }
      this.cycleTimer = setInterval(() => void this.nextPhoto(), STORED_FANART_INTERVAL_MS)
    },
    /** Banners are this card's shape; backgrounds only until connect has
     * downloaded some banners (it fetches them with every artist lookup). */
    async fetchStored(request: string[]): Promise<{ photos: StoredImage[]; kind: BackdropKind }> {
      const artists = request.length ? request : undefined
      try {
        const banners = await getStoredImages('banner', artists)
        if (banners.length) return { photos: banners, kind: 'banner' }
        return { photos: await getStoredImages('background', artists), kind: 'photo' }
      } catch (error) {
        console.error('[detail-header] Stored Fanart.tv images lookup failed:', error)
        return { photos: [], kind: 'banner' }
      }
    },
    async nextPhoto(): Promise<void> {
      // Nobody is looking at a hidden tab; the next tick tries again.
      if (document.hidden || !this.photos.length) return
      this.photoIndex += 1
      if (this.photoIndex >= this.photos.length) {
        // A fresh deal from connect for each round, rather than the same
        // order again - reshuffled here, it would lose connect's one artist
        // at a time.
        const request = this.storedFanartRequest
        const stored = request ? await this.fetchStored(request) : null
        if (JSON.stringify(this.storedFanartRequest) !== JSON.stringify(request)) return
        if (stored?.photos.length) {
          this.photos = stored.photos
          this.photoKind = stored.kind
        }
        this.photoIndex = 0
      }
      await this.showPhoto(this.photos[this.photoIndex]!)
    },
    /** Preloaded first, so the crossfade has an image to fade to (see
     * services/preloadImage.ts). */
    async showPhoto(photo: StoredImage): Promise<void> {
      const photos = this.photos
      await preloadImage(photo.url)
      if (this.photos !== photos) return
      this.show(photo.url, this.photoKind, photo.artists)
    },
    openArtist(layer: number): void {
      if (layer === this.backdrop.active && this.activeArtist) {
        this.$router.push(`/artists/${this.activeArtist.id}`)
      }
    },
    stopCycle(): void {
      if (this.cycleTimer) clearInterval(this.cycleTimer)
      this.cycleTimer = null
    },
    /** Opens the app-wide viewer (ArtworkLightbox.vue, mounted in App.vue)
     * rather than a dialog of this component's own — this header is on five
     * different pages, and the same picture is also opened from places that
     * have no header at all (a song row's context menu). */
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.coverArtId,
        imageUrl: this.imageUrl,
        title: this.title,
        subtitle: this.eyebrow || undefined,
        rounded: this.rounded,
        fallbackIcon: this.fallbackIcon,
      })
    },
  },
  watch: {
    // immediate — the first header should fade its artwork in rather than
    // staying blank until some *later* navigation changes it.
    backdropUrl: {
      immediate: true,
      handler(url: string | null) {
        if (!url && this.photos.length) return
        this.show(url, 'cover')
      },
    },
    storedFanartRequest: {
      immediate: true,
      handler(request: string[] | null, previous: string[] | null | undefined) {
        // A genre's artists arrive as a fresh array on every re-render of
        // the page; the same names are no reason to start over.
        if (JSON.stringify(request) === JSON.stringify(previous)) return
        void this.loadStoredFanart(request)
      },
    },
  },
  mounted() {
    this.measureText()
    // The window's width rewraps the text, and a bio or a longer title
    // arriving changes its size; updated() covers text that changes in
    // place.
    if (typeof ResizeObserver === 'undefined') return
    this.textObserver = new ResizeObserver(() => this.measureText())
    this.textObserver.observe(this.$refs.card as HTMLElement)
    this.textObserver.observe(this.$refs.text as HTMLElement)
  },
  updated() {
    this.measureText()
  },
  beforeUnmount() {
    this.textObserver?.disconnect()
    this.stopCycle()
  },
}
</script>

<style scoped>
.detail-header {
  /* Where the scrim behind the text has cleared - and so, wherever there
   * is room, where Fanart.tv art starts at the earliest. The scrim eases
   * out over --scrim-fade along a smoothstep curve: a straight ramp, over
   * a light picture, shows both of its ends as edges. */
  --scrim-fade: 280px;
  --text-clearance: calc(var(--text-end, 40%) + var(--scrim-fade));
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  margin-bottom: 32px;
  min-height: 280px;
  isolation: isolate;
  /* For the text-only band's height below, which follows this card's own
   * width. */
  container-type: inline-size;
}

.detail-header__backdrop {
  position: absolute;
  inset: -20px;
  background-image: var(--backdrop-image);
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
  /* Two stacked instances, one --active at a time — this opacity
   * transition is the crossfade itself. Same 0.6s as HeroBand.vue and
   * NowPlayingView.vue, so every backdrop in the app fades at one speed. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.detail-header__backdrop--active {
  opacity: 1;
}

/* The faded-out layer still lies on top half the time. */
.detail-header__backdrop:not(.detail-header__backdrop--active) {
  pointer-events: none;
}

/* Fanart.tv art (a banner, or a background photo until there is one):
 * whole, at the card's full height, so a wide window never crops its top
 * and bottom off. The spacers either side share out whatever width the
 * picture leaves equally, centring it (the left one is never narrower
 * than the text, below); where the card is narrower than the picture, both are 0 and its
 * left end is cut off. The spacers show the picture's own edge colours
 * (services/edgeFill.ts) out to the edges, opaque behind the text too;
 * the scrim above darkens it there, up to just past where the text ends
 * (--text-end, measured).
 * Kept 1px off the card's edge, with its own rounding: every layer is
 * clipped to the card's corners separately, and in the anti-aliased edge
 * pixels the scrim only partly covers art reaching them - a light rim
 * round the corners. */
.detail-header__backdrop--photo,
.detail-header__backdrop--banner {
  inset: 1px;
  border-radius: 15px;
  overflow: hidden;
  display: flex;
  justify-content: flex-end;
  background-image: none;
  filter: none;
  transform: none;
  --art-fade: linear-gradient(to right, transparent, #000 6%, #000 94%, transparent);
}

.detail-header__backdrop--photo::before,
.detail-header__backdrop--banner::before {
  content: '';
  flex: 1 0 0;
  /* At least up to just past the text, so the scrim darkens the edge
   * colour beside the picture rather than the picture itself - unless the
   * card is too narrow for both, when the picture keeps its right end and
   * slides under the text. */
  min-width: var(--text-clearance);
  /* Overlapping the picture: where the two meet on a fraction of a pixel,
   * each only partly covers that column and the dark card shows through
   * as a hairline. The overlap is under its fully faded end (--art-fade). */
  margin-right: -2px;
  background-image: var(--fill-left, none);
}

.detail-header__backdrop--photo::after,
.detail-header__backdrop--banner::after {
  content: '';
  flex: 1 0 0;
  margin-left: -2px;
  background-image: var(--fill-right, none);
}

/* Fanart.tv's fixed sizes: banners 1000x185, backgrounds 1920x1080. */
.detail-header__backdrop--banner {
  --art-ratio: 1000 / 185;
}

.detail-header__backdrop--photo {
  --art-ratio: 16 / 9;
}

/* Under the picture's ends, which only soften into its edge colours:
 * each half its own side's. */
.detail-header__backdrop-slot {
  flex: none;
  height: 100%;
  aspect-ratio: var(--art-ratio);
  background:
    var(--fill-left, none) left / 50% 100% no-repeat,
    var(--fill-right, none) right / 50% 100% no-repeat;
}

.detail-header__backdrop-art {
  height: 100%;
  background: var(--backdrop-image) center / cover no-repeat;
  -webkit-mask: var(--art-fade);
  mask: var(--art-fade);
}

.detail-header__backdrop-art--link {
  cursor: pointer;
}

.detail-header__scrim {
  position: absolute;
  inset: 0;
  /* Lets a click through to the picture (openArtist), as does the content
   * row below outside its own children. */
  pointer-events: none;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.75) 45%,
      rgba(245, 169, 78, 0.2) 100%
    ),
    linear-gradient(to top, rgba(18, 20, 28, 0.55), transparent 55%);
}

/* Over Fanart.tv art the scrim is plain black: the amber wash would read
 * as a colour cast on a sharp photo (over the blurred cover it reads as the
 * app's own light), and the app's blue-grey as a blue tint. Strong and even
 * behind the text, the art under it still just visible, then clear where
 * the art starts (--text-clearance) rather than at a share of the card. */
.detail-header__scrim--photo {
  background:
    linear-gradient(
      to right,
      rgba(0, 0, 0, 0.85) var(--text-end, 40%),
      rgba(0, 0, 0, 0.826) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.1),
      rgba(0, 0, 0, 0.762) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.2),
      rgba(0, 0, 0, 0.666) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.3),
      rgba(0, 0, 0, 0.551) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.4),
      rgba(0, 0, 0, 0.425) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.5),
      rgba(0, 0, 0, 0.299) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.6),
      rgba(0, 0, 0, 0.184) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.7),
      rgba(0, 0, 0, 0.088) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.8),
      rgba(0, 0, 0, 0.024) calc(var(--text-end, 40%) + var(--scrim-fade) * 0.9),
      rgba(0, 0, 0, 0) var(--text-clearance)
    ),
    linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent 55%);
}

.detail-header__top-right {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.detail-header__top-right-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.detail-header__content {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 28px;
  padding: 48px 32px 32px;
  pointer-events: none;
}

.detail-header__content > * {
  pointer-events: auto;
}

/* Centred rather than bottom-aligned with the text: once the text column
 * is the taller one (an artist's Wikipedia paragraph), the picture would
 * otherwise sink to the header's bottom edge. */
.detail-header__cover {
  flex-shrink: 0;
  align-self: center;
}

.detail-header__cover--zoomable {
  cursor: zoom-in;
}

.detail-header__title {
  margin-bottom: 6px;
}

/* No picture beside the text (a list page): the text centres in the card
 * the way the cover would, and the title grows to carry the card on its
 * own - up to the album page's name (DetailHero.vue), but always above
 * the usual 2.25rem, which the window-width part alone only passes on a
 * wide window.
 * Lower on a narrower card (a tablet): the text needs far less than 280px,
 * and a banner, sized to the card's height, keeps more of itself in view.
 * From a 1400px card up it is the full 280px. */
.detail-header--text-only {
  min-height: 0;
}

.detail-header--text-only .detail-header__content {
  min-height: clamp(200px, 20cqi, 280px);
  align-items: center;
  padding: clamp(20px, 2.3cqi, 32px) 32px;
}

.detail-header--text-only .detail-header__title {
  font-size: clamp(2.75rem, 3.2vw, 3.5rem);
}

/* No link-hover styling here (color-shift + underline) — this wraps
 * whatever the #subtitle slot is given, and that's plain non-interactive
 * text at one call site (PlaylistDetailView.vue's "by {owner}") and a real
 * router-link at another (AlbumDetailView.vue's artist name). A hover
 * effect here applied to *both* alike, making the plain-text case look
 * clickable when it isn't. Link styling belongs on the link itself — see
 * AlbumDetailView.vue's own .detail-header__subtitle-link. */
.detail-header__subtitle {
  color: rgba(255, 255, 255, 0.75);
  margin-bottom: 4px;
}

.detail-header__rating {
  margin: 6px 20px;
}

.detail-header__meta {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.8125rem;
}

.detail-header__actions {
  margin-top: 16px;
}

.min-width-0 {
  min-width: 0;
}

/* One line each — the name of an album or artist has no length limit,
 * and this header is a fixed band. */
.detail-header__title,
.detail-header__subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-header__eyebrow {
  margin-bottom: 4px;
}
</style>
