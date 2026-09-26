<template>
  <section ref="card" class="hero-band" :style="textEnd ? { '--text-end': `${textEnd}px` } : {}">
    <!-- Two stacked layers, only one visible at a time, so the artwork
     - crossfades when the hero switches to a different song — see
     - services/crossfadeBackdrop.ts for why one element can't do this. -->
    <div
      v-for="(url, i) in backdrop.urls"
      :key="i"
      class="hero-backdrop"
      :class="{
        'hero-backdrop--active': i === backdrop.active,
        'hero-backdrop--photo': layerKind[i] === 'photo',
        'hero-backdrop--banner': layerKind[i] === 'banner',
      }"
      :style="layerStyle(url, i)"
    >
      <div v-if="layerKind[i] !== 'cover'" class="hero-backdrop-slot">
        <div class="hero-backdrop-art" />
      </div>
    </div>
    <div
      class="hero-scrim"
      :class="{ 'hero-scrim--photo': layerKind[backdrop.active] !== 'cover' }"
    />
    <div ref="text" class="hero-content">
      <div v-if="loading" class="hero-body">
        <v-skeleton-loader type="image" width="132" height="132" class="hero-cover rounded" />
        <div class="hero-info min-width-0 hero-skel">
          <v-skeleton-loader type="text" width="140" height="17" class="hero-skel__eyebrow" />
          <v-skeleton-loader type="text" width="320" height="41" />
          <v-skeleton-loader type="text" width="220" height="24" class="hero-skel__subtitle" />
          <v-skeleton-loader type="text" width="180" height="36" class="hero-skel__button" />
        </div>
      </div>
      <div v-else-if="hasContent" class="hero-body">
        <!-- Whichever of the two the hero is currently showing: the
         - artwork of something playing opens Now Playing (see coverTo),
         - and the "nothing playing, here's your most recent album"
         - fallback keeps AlbumCard.vue's/SongRow.vue's own "click the
         - artwork to play" affordance. Either way it is a shortcut for
         - something already reachable next to it — the play button, or the
         - player bar's own artwork — never the only way there. -->
        <cover-art
          :cover-art-id="coverId"
          :image-url="imageUrl"
          :radio-favicon="radioFavicon"
          :size="132"
          class="hero-cover cover-shadow hero-cover--clickable"
          @click="onCoverClick"
          @loaded="loadedSrc = $event"
        />
        <div class="hero-info min-width-0">
          <div class="eyebrow-label hero-eyebrow">{{ eyebrow }}</div>
          <h1 class="detail-title hero-title">
            <router-link v-if="titleTo" :to="titleTo" class="hero-title-link">{{
              title
            }}</router-link>
            <template v-else>{{ title }}</template>
          </h1>
          <div class="hero-subtitle">
            <template v-if="artistName">
              <router-link
                v-if="artistId"
                :to="`/artists/${artistId}`"
                class="hero-subtitle-link"
                >{{ artistName }}</router-link
              >
              <span v-else>{{ artistName }}</span>
              <template v-if="albumName">
                ·
                <router-link v-if="albumId" :to="`/albums/${albumId}`" class="hero-subtitle-link">{{
                  albumName
                }}</router-link>
                <span v-else>{{ albumName }}</span>
              </template>
            </template>
            <template v-else>{{ subtitle }}</template>
          </div>
          <div class="hero-actions">
            <v-btn
              color="primary"
              :prepend-icon="isPlayingThis ? 'mdi-pause' : 'mdi-play'"
              rounded="pill"
              @click="$emit('play')"
            >
              {{ isPlayingThis ? $t('home.paused') : $t('home.keepListening') }}
            </v-btn>
            <!-- Secondary on purpose: the pill above is what this band is
             - for. Only shown when the hero is a *song* (the seed a mix is
             - built from) and the server can build one at all — see
             - HomeView.vue's heroCanStartRadio. -->
            <v-btn
              v-if="canStartRadio"
              prepend-icon="mdi-radio-tower"
              rounded="pill"
              color="primary"
              :loading="radioLoading"
              @click="$emit('song-radio')"
            >
              {{ $t('library.songRadio') }}
            </v-btn>
          </div>
        </div>
      </div>
      <div v-else class="hero-body">
        <div class="hero-info">
          <h1 class="detail-title hero-title">{{ $t('home.readyToPlay') }}</h1>
          <div class="hero-subtitle">{{ $t('home.nothingHeardYet') }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import { useLibraryStore } from '@/stores/library'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { type EdgeGradients, extractEdgeGradients } from '@/services/edgeFill'
import { textEnd } from '@/services/textExtent'
import { getArtistArt } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'

/** A Fanart.tv banner across the whole band, a background photo at its
 * right edge, or the blurred cover. */
type BackdropKind = 'banner' | 'photo' | 'cover'

/** What the backdrop should show; null while the artist's art is still
 * being looked up, which keeps whatever is showing now. */
interface BackdropTarget {
  url: string | null
  kind: BackdropKind
}

export default {
  name: 'HeroBand',
  components: { CoverArt },
  props: {
    coverId: { type: String as PropType<string | null>, default: null },
    imageUrl: { type: String as PropType<string | null>, default: null },
    /** A radio station's logo, resolved in a batch rather than fetched from
     * a URL — see CoverArt.vue's own prop of the same name. */
    radioFavicon: { type: Object as PropType<RadioFaviconRequest | null>, default: null },
    eyebrow: { type: String, default: '' },
    title: { type: String, default: '' },
    // Route for the title itself — only meaningful when `title` names an
    // album (the "nothing playing, here's your most recent album" fallback
    // state; see HomeView.vue's heroTitle/heroTitleTo). When a song is
    // playing, `title` is the *song's* name instead, which has no page of
    // its own in this app to link to.
    titleTo: { type: String as PropType<string | null>, default: null },
    // Where clicking the artwork goes, when it leads anywhere: Now Playing
    // while something is actually playing. Null in the "nothing playing,
    // here's your most recent album" state, where the artwork keeps its
    // older meaning and starts that album — Now Playing would have nothing
    // to show there, and the artwork on screen is a suggestion rather than
    // something already loaded. HomeView.vue decides which state it is in,
    // same division of labour as titleTo above.
    coverTo: { type: String as PropType<string | null>, default: null },
    // Plain-text-only fallback subtitle (radio's "Internet Radio" label) —
    // used only when neither artistName nor albumName is given below.
    subtitle: { type: String, default: '' },
    // Split out from a single formatted "Artist · Album" string (the
    // previous shape of `subtitle`) so each half can link to its own page,
    // same as everywhere else in the library (AlbumCard.vue, DetailHeader
    // consumers, ...) — a null *Id with a non-null name still renders the
    // name as plain text instead of silently dropping it.
    artistName: { type: String as PropType<string | null>, default: null },
    artistId: { type: String as PropType<string | null>, default: null },
    albumName: { type: String as PropType<string | null>, default: null },
    albumId: { type: String as PropType<string | null>, default: null },
    isPlayingThis: { type: Boolean, default: false },
    hasContent: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    // Whether a Song Radio can be built from whatever the hero is showing
    // right now — the decision itself is HomeView.vue's (it owns both the
    // seed song and the server capability), this component only renders
    // the button or doesn't.
    canStartRadio: { type: Boolean, default: false },
    radioLoading: { type: Boolean, default: false },
  },
  emits: ['play', 'song-radio'],
  data() {
    return {
      backdrop: createBackdropLayers(),
      // Per layer, since Fanart.tv art is shown sharp and a cover blurred.
      layerKind: ['cover', 'cover'] as BackdropKind[],
      /** Per layer: its Fanart.tv art's edge colours, continued beside it. */
      fills: [null, null] as (EdgeGradients | null)[],
      /** Where the text ends, in px from the left: the art is faded out
       * up to there (see measureText). */
      textEnd: 0,
      textObserver: null as ResizeObserver | null,
      artistArt: null as { url: string; kind: BackdropKind } | null,
      artResolved: true,
      // Whatever <cover-art> ended up showing, reported by it. Null until
      // something has actually loaded.
      loadedSrc: null as string | null,
    }
  },
  computed: {
    // Both of the URL-shaped sources can be turned into a backdrop
    // directly, so those are up as soon as the cover is rather than after
    // it. A radio logo is the one that can't: it is resolved in a batch
    // rather than fetched from an address, and there is no URL to blur
    // until <cover-art> reports the one it ended up showing.
    coverBackdropUrl(): string | null {
      if (this.coverId) return useLibraryStore().client().coverArtUrl(this.coverId, 300)
      return this.imageUrl ?? this.loadedSrc
    },
    fanartArtist(): string | null {
      return useFanartStore().enabled && this.hasContent ? this.artistName : null
    },
    // The artist's Fanart.tv banner, which is already the band's shape;
    // else their background photo (the one the artist page and Now Playing
    // show this session); else the blurred cover. Held until the lookup
    // answers, like the album page, so the band fades once to the right
    // picture instead of cover-then-art.
    backdropTarget(): BackdropTarget | null {
      if (!this.artResolved) return null
      if (this.artistArt) return this.artistArt
      return { url: this.coverBackdropUrl, kind: 'cover' }
    },
  },
  methods: {
    measureText(): void {
      const card = this.$refs.card as HTMLElement | undefined
      const text = this.$refs.text as HTMLElement | undefined
      if (card && text) this.textEnd = Math.round(textEnd(text, card))
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
    async loadArtistPhoto(name: string | null): Promise<void> {
      if (!name) {
        this.artistArt = null
        this.artResolved = true
        return
      }
      this.artResolved = false
      let found: { url: string; kind: BackdropKind } | null = null
      try {
        const art = await getArtistArt(name)
        if (art?.banner) found = { url: art.banner, kind: 'banner' }
        else if (art?.background) found = { url: art.background, kind: 'photo' }
        // Preloaded, so the crossfade has an image to fade to.
        if (found) await preloadImage(found.url)
      } catch (error) {
        console.error('[hero-band] Fanart.tv lookup failed:', error)
      }
      // The hero may have moved on to another song meanwhile.
      if (this.fanartArtist !== name) return
      this.artistArt = found
      this.artResolved = true
    },
    onCoverClick() {
      if (this.coverTo) this.$router.push(this.coverTo)
      else this.$emit('play')
    },
  },
  watch: {
    // immediate — the first hero should fade in from nothing rather than
    // waiting for a *second* one before the backdrop ever appears.
    fanartArtist: {
      immediate: true,
      handler(name: string | null) {
        void this.loadArtistPhoto(name)
      },
    },
    backdropTarget: {
      immediate: true,
      handler(target: BackdropTarget | null, previous: BackdropTarget | null | undefined) {
        if (!target) return
        if (previous && target.url === previous.url && target.kind === previous.kind) return
        showBackdrop(this.backdrop, target.url)
        this.layerKind[this.backdrop.active] = target.kind
        void this.paintFill(this.backdrop.active, target.url, target.kind)
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
  },
}
</script>

<style scoped>
.hero-actions {
  display: flex;
  align-items: center;
  /* Wraps rather than squeezing both pills onto one line on a narrow
   * window — the band's own min-height already accommodates a second row. */
  flex-wrap: wrap;
  gap: 8px;
}

.hero-band {
  /* Where the scrim behind the text has cleared - and so, wherever there
   * is room, where Fanart.tv art starts at the earliest. The scrim eases
   * out over --scrim-fade along a smoothstep curve: a straight ramp, over
   * a light picture, shows both of its ends as edges. */
  --scrim-fade: 280px;
  --text-clearance: calc(var(--text-end, 40%) + var(--scrim-fade));
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  margin-bottom: 40px;
  min-height: 220px;
  isolation: isolate;
}

.hero-backdrop {
  position: absolute;
  inset: -20px;
  background-image: var(--backdrop-image);
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
  /* Two stacked instances of this, only one of them --active at a time —
   * this opacity transition is the crossfade itself. Same 0.6s as
   * DetailHeader.vue and NowPlayingView.vue, so every backdrop in the app
   * fades at one speed (and a song change, which updates two of them at
   * once, stays in step). */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.hero-backdrop--active {
  opacity: 1;
}

/* Fanart.tv art (a banner, or a background photo until there is one):
 * whole, at the band's full height, so a wide window never crops its top
 * and bottom off. The spacers either side share out whatever width the
 * picture leaves equally, centring it (the left one is never narrower
 * than the text, below); where the band is narrower than the picture, both are 0 and its
 * left end is cut off. The spacers show the picture's own edge colours
 * (services/edgeFill.ts) out to the edges, opaque behind the text too;
 * the scrim above darkens it there, up to just past where the text ends
 * (--text-end, measured).
 * Kept 1px off the band's edge, with its own rounding: every layer is
 * clipped to the band's corners separately, and in the anti-aliased edge
 * pixels the scrim only partly covers art reaching them - a light rim
 * round the corners. */
.hero-backdrop--photo,
.hero-backdrop--banner {
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

.hero-backdrop--photo::before,
.hero-backdrop--banner::before {
  content: '';
  flex: 1 0 0;
  /* At least up to just past the text, so the scrim darkens the edge
   * colour beside the picture rather than the picture itself - unless the
   * band is too narrow for both, when the picture keeps its right end and
   * slides under the text. */
  min-width: var(--text-clearance);
  /* Overlapping the picture: where the two meet on a fraction of a pixel,
   * each only partly covers that column and the dark card shows through
   * as a hairline. The overlap is under its fully faded end (--art-fade). */
  margin-right: -2px;
  background-image: var(--fill-left, none);
}

.hero-backdrop--photo::after,
.hero-backdrop--banner::after {
  content: '';
  flex: 1 0 0;
  margin-left: -2px;
  background-image: var(--fill-right, none);
}

/* Fanart.tv's fixed sizes: banners 1000x185, backgrounds 1920x1080. */
.hero-backdrop--banner {
  --art-ratio: 1000 / 185;
}

.hero-backdrop--photo {
  --art-ratio: 16 / 9;
}

/* Under the picture's ends, which only soften into its edge colours:
 * each half its own side's. */
.hero-backdrop-slot {
  flex: none;
  height: 100%;
  aspect-ratio: var(--art-ratio);
  background:
    var(--fill-left, none) left / 50% 100% no-repeat,
    var(--fill-right, none) right / 50% 100% no-repeat;
}

.hero-backdrop-art {
  height: 100%;
  background: var(--backdrop-image) center / cover no-repeat;
  -webkit-mask: var(--art-fade);
  mask: var(--art-fade);
}

.hero-scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.72) 45%,
      rgba(245, 169, 78, 0.22) 100%
    ),
    linear-gradient(to top, rgba(18, 20, 28, 0.6), transparent 60%);
}

/* Plain black over sharp Fanart.tv art, strong behind the text and clear
 * where the art starts - see DetailHeader.vue's identical rule. */
.hero-scrim--photo {
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
    linear-gradient(to top, rgba(0, 0, 0, 0.6), transparent 60%);
}

.hero-content {
  position: relative;
  padding: 32px 36px;
}

.hero-body {
  display: flex;
  align-items: center;
  gap: 24px;
}

.hero-cover {
  flex-shrink: 0;
}

.hero-cover--clickable {
  cursor: pointer;
}

.hero-subtitle {
  color: rgba(255, 255, 255, 0.65);
  margin-top: 4px;
}

.hero-title-link,
.hero-subtitle-link {
  color: inherit;
  text-decoration: none;
}

.hero-title-link:hover,
.hero-subtitle-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

.min-width-0 {
  min-width: 0;
}

/* v-skeleton-loader's bones ignore the component's own width/height props
 * (fixed CSS heights + margin baked in) — those props only size the outer
 * wrapper. Forcing each bone to fill its wrapper exactly, combined with
 * heights computed from the real typography (eyebrow-label 17px,
 * detail-title 41px, hero-subtitle 24px, the button's 36px), is what keeps
 * the hero band's height identical between loading and loaded — nothing
 * below it jumps once the real content swaps in. */
.hero-skel :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

/* The band is a fixed height; both lines clip. */
.hero-title,
.hero-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-eyebrow {
  margin-bottom: 4px;
}

.hero-actions {
  margin-top: 16px;
}

/* The placeholders mirror the real band's own gaps, so nothing shifts
 * when the album arrives. */
.hero-skel__eyebrow {
  margin-bottom: 4px;
}

.hero-skel__subtitle {
  margin-top: 4px;
}

.hero-skel__button {
  margin-top: 16px;
  border-radius: 9999px;
}
</style>
