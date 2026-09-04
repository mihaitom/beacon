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
        :rounded="view.rounded"
        :fallback-icon="view.fallbackIcon ?? 'mdi-album'"
        :size="artSize"
        class="artwork-lightbox__art"
      />
      <div class="artwork-lightbox__caption">
        <div class="text-body-large text-truncate">{{ view.title }}</div>
        <div v-if="view.subtitle" class="text-body-small text-medium-emphasis text-truncate">
          {{ view.subtitle }}
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import { emitter } from '@/emitter'
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
</style>
