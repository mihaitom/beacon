<template>
  <cover-frame
    :src="failed ? null : src"
    :size="size"
    :contain="contain"
    :fallback-icon="fallbackIcon"
    @error="failed = true"
  />
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverFrame from '@/components/library/CoverFrame.vue'

/** The party guest page's cover: the app's own CoverFrame, fed a ready URL
 * connect serves instead of CoverArt's batched, token-carrying fetch - which
 * would pull the library store into the guest bundle.
 *
 * Takes CoverArt's props too (the host's `coverArtId` and `radioFavicon`
 * routes are simply unused here - a guest only ever has a ready URL in
 * `src`). A contained image is a station logo, the only one connect
 * measures for transparency; a song cover is never asked. */
export default {
  name: 'GuestCover',
  components: { CoverFrame },
  props: {
    src: {
      type: String as PropType<string | null>,
      default: null,
    },
    // Accepted for prop-shape parity with CoverArt; unused by a guest.
    coverArtId: {
      type: String as PropType<string | null>,
      default: null,
    },
    radioFavicon: {
      type: Object as PropType<unknown>,
      default: null,
    },
    size: {
      type: [Number, String] as PropType<number | string>,
      default: 160,
    },
    contain: {
      type: Boolean,
      default: false,
    },
    fallbackIcon: {
      type: String,
      default: 'mdi-album',
    },
  },
  emits: ['transparency'],
  data() {
    // A URL that failed shows the fallback icon, as CoverArt does once its
    // candidates are spent.
    return { failed: false }
  },
  watch: {
    src() {
      this.failed = false
      if (this.contain && this.src) void this.checkTransparency(this.src)
    },
  },
  mounted() {
    if (this.contain && this.src) void this.checkTransparency(this.src)
  },
  methods: {
    /** connect measures the logo (routes/radio.py's _has_transparency) and
     * says so in a header an <img> cannot read; the image itself then comes
     * out of the browser's cache. */
    async checkTransparency(url: string) {
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (url !== this.src) return
        this.$emit('transparency', response.headers.get('X-Has-Transparency') === 'true')
      } catch {
        // Shown with a card, as before its reading arrives.
      }
    },
  },
}
</script>
