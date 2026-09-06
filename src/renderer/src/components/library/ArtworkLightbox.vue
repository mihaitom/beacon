<template>
  <!-- No v-card around it: this is one picture on a dimmed backdrop, and a
   - card's own surface would draw a visible sheet behind artwork that is
   - frequently not square (an artist photo, a wide radio logo). Clicking
   - the artwork itself closes too, so the whole overlay behaves like the
   - one dismissable surface it looks like. -->
  <v-dialog v-model="visible" :max-width="maxWidth" class="artwork-lightbox">
    <div v-if="view" class="artwork-lightbox__frame" @click="visible = false">
      <!-- contain, not the default crop: this view exists to show the
       - picture as it is, and an artist photo is frequently portrait while
       - the box below is square. -->
      <cover-art
        full-size
        contain
        :cover-art-id="view.coverArtId"
        :image-url="view.imageUrl"
        :lazy-src="placeholderUrl ?? ''"
        :rounded="view.rounded"
        :fallback-icon="view.fallbackIcon ?? 'mdi-album'"
        :size="artSize"
        class="artwork-lightbox__art"
      />
      <div class="artwork-lightbox__caption">
        <div class="text-body-large">{{ view.title }}</div>
        <div v-if="view.subtitle" class="text-body-small text-medium-emphasis">
          {{ view.subtitle }}
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import type { ArtworkView } from '@/types/events'

// The artwork's box, and with it the dialog's own width. Both sides are
// viewport units on purpose: CoverArt.vue's box is a square whose width and
// height both come from this one value, and a percentage in it (this used
// to be `min(82vh, 100%)`) has nothing definite to resolve its *height*
// against — the parent's height is auto — so the cap silently fell back to
// the image's own size, and a portrait artist photo ran off the bottom of
// the window. Reported live 2026-09-04.
//
// 72vh rather than filling the window: the caption sits under it, and the
// dialog itself keeps a margin from the edges (Vuetify's own overlay
// inset), both of which come out of the same 100vh.
const ART_SIZE = 'min(72vh, 86vw)'

// See placeholderUrl() for why this particular number.
const PLACEHOLDER_SIZE = 300

export default {
  name: 'ArtworkLightbox',
  components: { CoverArt },
  data() {
    return {
      visible: false,
      // Kept while closing rather than cleared with `visible`: the dialog
      // fades out, and dropping the artwork on the same tick would blank
      // the picture before the animation that is still showing it ends.
      view: null as ArtworkView | null,
      listener: null as ((view: ArtworkView) => void) | null,
    }
  },
  computed: {
    /** The small copy shown while the full-size one downloads. Whoever
     * opened the viewer can name it (an external artist's card photo, which
     * has no cover-art id at all), and otherwise it is derived here rather
     * than in each of the six places that open this: they all have the same
     * cover-art id and would all build the same URL.
     *
     * 300px because that is the size DetailHeader.vue's blurred backdrop
     * already asks for - so on an album, artist, genre or playlist page,
     * where most of these are opened from, the picture is in the browser's
     * cache before the click and appears instantly. Elsewhere it is a small
     * fetch that still lands long before the 1280px one behind it. */
    placeholderUrl(): string | null {
      if (this.view?.placeholderImageUrl) return this.view.placeholderImageUrl
      if (!this.view?.coverArtId) return null
      return useLibraryStore().client().coverArtUrl(this.view.coverArtId, PLACEHOLDER_SIZE)
    },
    artSize(): string {
      return ART_SIZE
    },
    // The dialog is exactly as wide as the artwork it holds, so the caption
    // underneath lines up with the picture rather than with a wider sheet.
    maxWidth(): string {
      return ART_SIZE
    },
  },
  mounted() {
    this.listener = (view: ArtworkView) => {
      this.view = view
      this.visible = true
    }
    emitter.on('showArtwork', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('showArtwork', this.listener)
  },
}
</script>

<style scoped>
/* Darker than an ordinary dialog's backdrop. Vuetify dims every overlay by
 * the same 0.32 (--v-overlay-opacity, VOverlay.css), which is the right
 * amount for a dialog you read while still wanting the page behind it for
 * context. This one is a picture being looked at, and the room around it
 * should get out of the way instead.
 *
 * Set as that variable rather than as a rule on .v-overlay__scrim itself,
 * so the scrim stays exactly what Vuetify computes it to be and only the
 * one number it computes it from changes. It reaches the scrim by
 * inheritance, which is also why this needs no :deep(): the scrim is a
 * child of the element this class lands on (v-dialog forwards `class` to
 * the overlay root), and custom properties inherit down into it wherever
 * Vuetify teleports it to.
 *
 * Unlayered, so it wins over Vuetify's own layered `.v-overlay`
 * declaration however specific that one is - see base.css on the layer
 * order. */
.artwork-lightbox {
  --v-overlay-opacity: 0.85;
}

.artwork-lightbox__frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  cursor: zoom-out;
}

/* A second cap on top of the `size` above, in case a box ever gets its
 * dimensions from somewhere else (CoverArt.vue's rounded branch is a
 * v-avatar, not a plain div): whatever it is, it cannot outgrow the window
 * it is being shown in. */
.artwork-lightbox__art {
  max-width: 86vw;
  max-height: 72vh;
}

/* No fill behind the picture. CoverArt paints a faint one so that a cover
 * still reads as a tile before it has arrived, which is right in a grid -
 * but this box is square and the picture inside it is `contain`ed, so on
 * anything that is not square the fill is what is left over: grey bars
 * down both sides of a portrait artist photo, or above and below a wide
 * station logo. This view is one picture on a dimmed backdrop and there
 * should be nothing behind it at all.
 *
 * Two classes rather than one, and the v-avatar branch named separately:
 * .artwork-lightbox__art lands on CoverArt's own root element, so a rule
 * on it alone ties with that component's own `.cover-art` rule on
 * specificity and the winner is decided by stylesheet order. Pairing it
 * with the class it is overriding settles it. Same technique, and the same
 * reason, as .radio-cover-art--transparent in NowPlayingView.vue. */
.artwork-lightbox__art.cover-art,
.artwork-lightbox__art.v-avatar {
  background: transparent;
}

.artwork-lightbox__caption {
  max-width: 100%;
  text-align: center;
  /* Its own surface, not the dialog's: the caption sits on the dimmed
   * backdrop, where plain text would be at the mercy of whatever the
   * artwork behind it happens to be. */
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.85);
}

/* The caption is one line over the dimmed backdrop. */
.artwork-lightbox__caption > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
