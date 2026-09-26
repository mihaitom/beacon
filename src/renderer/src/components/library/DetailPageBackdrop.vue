<template>
  <div class="detail-page" :class="{ 'detail-page--banded': banded }">
    <div
      ref="band"
      class="detail-page__band"
      :style="textEnd ? { '--text-end': `${textEnd}px` } : {}"
    >
      <!-- The artwork layer, across the top and masked out towards the
       - bottom so the content below sits on the plain surface. `url` is
       - held back (null) until the lookup answers, so the page never shows
       - the fallback and then swaps to a photo. Two layers so a change
       - fades rather than cuts (see services/crossfadeBackdrop.ts). -->
      <template v-if="show">
        <div
          v-for="(layerUrl, index) in layers.urls"
          :key="index"
          class="detail-page__backdrop"
          :class="{
            'detail-page__backdrop--photo': layerIsPhoto[index],
            'detail-page__backdrop--filled': layerIsPhoto[index] && Boolean(fills[index]),
            'detail-page__backdrop--shown': index === layers.active && Boolean(layerUrl),
          }"
          :style="layerStyle(layerUrl, index)"
        >
          <template v-if="layerIsPhoto[index]">
            <div v-if="fills[index]" class="detail-page__fill" />
            <div class="detail-page__art">
              <div class="detail-page__shade" />
            </div>
          </template>
        </div>
        <div class="detail-page__scrim" />
      </template>
      <div ref="content" class="detail-page__content">
        <slot />
      </div>
    </div>
    <div v-if="$slots.below" class="detail-page__below">
      <slot name="below" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { type Frame, extractLeftEdgeGradient } from '@/services/edgeFill'
import { textEnd } from '@/services/textExtent'

/**
 * A detail page's backdrop: a Fanart.tv photo shown sharp when there is
 * one, the blurred cover wash otherwise, over a scrim that keeps the header
 * text readable. Shared by ArtistDetailView.vue and AlbumDetailView.vue; the
 * page decides which url to hand in and whether it is a photo (see their
 * own backdropUrl/backdropIsPhoto).
 *
 * A photo stays opaque behind the header text, darkened there instead
 * (measured, services/textExtent.ts). It keeps to the right edge; one whose
 * left edge is smooth has that edge continued to its left
 * (services/edgeFill.ts), as DetailHeader.vue's banners do, and one whose
 * isn't fades out to the left, since continuing a busy edge streaks.
 */
/** How the photo is framed - the `--art-ratio` and background-position in
 * the styles below, which the edge is read to match. */
const PHOTO_FRAME: Frame = { ratio: 16 / 9, positionY: 0.5 }
const BANDED_PHOTO_FRAME: Frame = { ratio: 2.4, positionY: 0.25 }
/** How much of the photo, from the top, its edge is judged by: below 75%
 * the band's fade to the page has it under ~40% on both arrangements. */
const JUDGED_EXTENT = 0.75

export default {
  name: 'DetailPageBackdrop',
  props: {
    /** The backdrop image, or null while it is still being resolved. */
    url: { type: String as PropType<string | null>, default: null },
    /** Whether `url` is a full-size Fanart.tv photo (sharp) rather than a
     * cover to blur into a wash. */
    isPhoto: { type: Boolean, default: false },
    /** Whether the page's subject has loaded at all - no backdrop is drawn
     * until it has. */
    show: { type: Boolean, default: true },
    /** The album page's arrangement: the page is exactly the window's
     * height, the backdrop spans the header (the default slot) and fades out
     * at its bottom edge, and the #below content (the track list) scrolls
     * on its own under it, so the header stays in view. Without it the band
     * is a fixed height behind all of the content, which the artist page's
     * bio and album shelf can take, and the whole page scrolls. */
    banded: { type: Boolean, default: false },
  },
  data() {
    return {
      layers: createBackdropLayers(),
      // Per layer, since the one fading out may be a photo while the one
      // fading in is a blurred cover, or the other way round.
      layerIsPhoto: [false, false],
      /** Per layer: the photo's left edge, continued to its left - where
       * that edge is smooth enough to. */
      fills: [null, null] as (string | null)[],
      /** Where the header text ends, in px from the band's left. */
      textEnd: 0,
      textObserver: null as ResizeObserver | null,
    }
  },
  methods: {
    layerStyle(url: string | null, index: number): Record<string, string> {
      const fill = this.fills[index]
      return {
        ...(url ? { '--backdrop-image': `url(${url})` } : {}),
        ...(fill ? { '--fill-left': fill } : {}),
      }
    },
    async paintFill(index: number, url: string | null, isPhoto: boolean): Promise<void> {
      this.fills[index] = null
      if (!url || !isPhoto) return
      const gradient = await extractLeftEdgeGradient(
        url,
        this.banded ? BANDED_PHOTO_FRAME : PHOTO_FRAME,
        JUDGED_EXTENT,
      )
      if (this.layers.urls[index] === url) this.fills[index] = gradient
    },
    /** The header's own text only - DetailHero.vue's cover/name column and
     * bio, not its rating controls, nor the artist page's album shelves
     * further down the band. */
    measureText(): void {
      const band = this.$refs.band as HTMLElement | undefined
      const content = this.$refs.content as HTMLElement | undefined
      if (!band || !content) return
      const hero = content.querySelectorAll('.detail-hero__main, .detail-hero__bio')
      const roots = hero.length ? [...hero] : [content]
      this.textEnd = Math.round(Math.max(...roots.map((root) => textEnd(root, band))))
    },
  },
  watch: {
    url: {
      immediate: true,
      handler(url: string | null) {
        showBackdrop(this.layers, url)
        this.layerIsPhoto[this.layers.active] = this.isPhoto
        void this.paintFill(this.layers.active, url, this.isPhoto)
      },
    },
  },
  mounted() {
    this.measureText()
    // The window's width rewraps the text, and a bio arriving changes its
    // size; updated() covers text that changes in place.
    if (typeof ResizeObserver === 'undefined') return
    this.textObserver = new ResizeObserver(() => this.measureText())
    this.textObserver.observe(this.$refs.band as HTMLElement)
    this.textObserver.observe(this.$refs.content as HTMLElement)
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
.detail-page__band {
  position: relative;
  /* The cover wash is scaled past the band's edges (see its own rule), and
   * anything past the window's right edge makes a tablet's browser lay the
   * whole page out wider than the screen: the player bar ended up off the
   * bottom and right. Sideways only - the backdrop may run on below the
   * band - and `clip`, so this is no scroll container. */
  overflow-x: clip;
  /* A photo's fade to the left where its edge isn't continued, eased
   * rather than linear: a straight ramp starts with a visible step in
   * brightness, which reads as a seam. Over its first 30%, so most of the
   * photo stays whole. */
  --detail-page-photo-fade: linear-gradient(
    to right,
    transparent 0%,
    rgba(0, 0, 0, 0.06) 4.4%,
    rgba(0, 0, 0, 0.2) 8.7%,
    rgba(0, 0, 0, 0.42) 13.6%,
    rgba(0, 0, 0, 0.68) 19.1%,
    rgba(0, 0, 0, 0.88) 24.5%,
    #000 30%
  );
  /* The album page's fade into the track list, eased the same way. */
  --detail-page-banded-fade: linear-gradient(
    to bottom,
    #000 0%,
    #000 35%,
    rgba(0, 0, 0, 0.82) 50%,
    rgba(0, 0, 0, 0.58) 63%,
    rgba(0, 0, 0, 0.34) 75%,
    rgba(0, 0, 0, 0.15) 86%,
    rgba(0, 0, 0, 0.04) 94%,
    transparent 100%
  );
  /* The header text's shade over a photo: plain black, strong and even up
   * to where the text ends, then eased out over --scrim-fade along a
   * smoothstep curve - a straight ramp, over a light photo, shows both of
   * its ends as edges. Same as DetailHeader.vue's. */
  --scrim-fade: 280px;
  --text-clearance: calc(var(--text-end, 0px) + var(--scrim-fade));
  --text-shade: linear-gradient(
    to right,
    rgba(0, 0, 0, 0.85) var(--text-end, 0px),
    rgba(0, 0, 0, 0.826) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.1),
    rgba(0, 0, 0, 0.762) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.2),
    rgba(0, 0, 0, 0.666) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.3),
    rgba(0, 0, 0, 0.551) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.4),
    rgba(0, 0, 0, 0.425) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.5),
    rgba(0, 0, 0, 0.299) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.6),
    rgba(0, 0, 0, 0.184) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.7),
    rgba(0, 0, 0, 0.088) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.8),
    rgba(0, 0, 0, 0.024) calc(var(--text-end, 0px) + var(--scrim-fade) * 0.9),
    rgba(0, 0, 0, 0) var(--text-clearance)
  );
}

.detail-page__backdrop,
.detail-page__scrim {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: min(78vh, 680px);
  pointer-events: none;
}

.detail-page__backdrop {
  background-image: var(--backdrop-image);
  background-size: cover;
  background-position: center 22%;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  /* Held back until the lookup answers (see the page's backdropUrl), then
   * faded in - so it never shows the cover and swaps to the background. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.detail-page__backdrop--shown {
  opacity: 1;
}

/* A photo is a 16:9 area at the band's height rather than the full width,
 * so a band wider than 16:9 doesn't crop its top and bottom off (heads,
 * mostly); below 16:9 it is the full band, cropped at the sides. Its width
 * and place are worked out here from the layer's size (a size container)
 * so that the shade, which must only darken the photo and not the page
 * beside it, can line up with the text in the band's own coordinates.
 * It keeps to the right edge; with a left edge too busy to continue, it
 * fades out to the left onto the page's surface. */
.detail-page__backdrop--photo {
  container-type: size;
  background-image: none;
  /* Kept in step with PHOTO_FRAME in the script. */
  --art-ratio: 1.7778;
  --art-width: min(100cqw, 100cqh * var(--art-ratio));
  --art-left: calc(100cqw - var(--art-width));
}

/* A smooth left edge, continued from the band's left edge to under the
 * photo, shaded behind the text like the photo itself. */
.detail-page__fill {
  position: absolute;
  inset: 0;
  background:
    var(--text-shade),
    var(--fill-left) left / calc(var(--art-left) + var(--art-width) / 2) 100% no-repeat;
}

.detail-page__art {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--art-left);
  width: var(--art-width);
  overflow: hidden;
  background: var(--backdrop-image) center / cover no-repeat;
  -webkit-mask-image: var(--detail-page-photo-fade);
  mask-image: var(--detail-page-photo-fade);
}

/* Only softening its left end into the continued edge: that is a band's
 * average, so the edge's own detail wants a little distance to go. */
.detail-page__backdrop--filled .detail-page__art {
  -webkit-mask-image: linear-gradient(to right, transparent, #000 12%);
  mask-image: linear-gradient(to right, transparent, #000 12%);
}

/* The band's width, shifted back to the band's left edge, so the shade's
 * stops land where the text is; clipped to the photo by its overflow. */
.detail-page__shade {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--art-left));
  width: 100cqw;
  background: var(--text-shade);
}

/* The window below the app bar and above the player bar. */
.detail-page--banded {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
}

.detail-page--banded .detail-page__band {
  flex: none;
}

.detail-page--banded .detail-page__below {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.detail-page--banded .detail-page__backdrop,
.detail-page--banded .detail-page__scrim {
  height: auto;
  bottom: 0;
}

/* Eased out to nothing by the header's bottom edge, where the track list
 * starts - a linear fade still showed a band of photo there, which read as
 * an edge. */
.detail-page--banded .detail-page__backdrop {
  -webkit-mask-image: var(--detail-page-banded-fade);
  mask-image: var(--detail-page-banded-fade);
}

/* Wider than 16:9 here: the album page's header is shallow enough that a
 * 16:9 photo covers barely half its width and leaves the rest looking
 * empty. The crop costs some of the photo's top and bottom, so it is held
 * towards the top, where the faces usually are. */
.detail-page--banded .detail-page__backdrop--photo {
  /* Kept in step with BANDED_PHOTO_FRAME in the script. */
  --art-ratio: 2.4;
}

.detail-page--banded .detail-page__art {
  background-position: center 25%;
}

/* A phone stacks the hero's text under the cover, across the full width,
 * so there is no text column to keep clear or shade - the photo keeps all
 * of it. It
 * also has no height to spare for a header that stays put, so the page
 * scrolls as one there. */
@media (max-width: 599px) {
  .detail-page--banded {
    height: auto;
  }

  .detail-page--banded .detail-page__below {
    overflow-y: visible;
  }

  .detail-page__band {
    --text-shade: none;
  }

  .detail-page__art,
  .detail-page__backdrop--filled .detail-page__art {
    -webkit-mask-image: none;
    mask-image: none;
  }
}

/* Without a Fanart.tv background the fallback is the blurred cover wash -
 * the app's one backdrop recipe (see docs/styleguide.md). */
.detail-page__backdrop:not(.detail-page__backdrop--photo) {
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.1);
  transform-origin: top center;
}

/* Keeps the header text readable over a bright background photo, and eases
 * the top edge into the chrome. */
.detail-page__scrim {
  background: linear-gradient(
    to bottom,
    rgba(18, 20, 28, 0.72) 0%,
    rgba(18, 20, 28, 0.3) 38%,
    rgba(18, 20, 28, 0) 100%
  );
}

.detail-page__content,
.detail-page__below {
  position: relative;
  z-index: 1;
}
</style>
