<template>
  <div
    class="guest-cover"
    :class="{ 'guest-cover--contain': contain, 'guest-cover--transparent': transparent }"
    :style="{ width: sizeCss, height: sizeCss }"
  >
    <img
      v-if="src"
      :src="src"
      alt=""
      class="guest-cover__img"
      :class="{ 'guest-cover__img--contain': contain }"
      @load="$emit('loaded', src)"
      @error="$emit('loaded', null)"
    />
    <div v-else class="guest-cover__fallback">
      <v-icon :icon="fallbackIcon" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

/** The party guest page's cover image: a store-free stand-in for the app's
 * batched CoverArt, so the shared Now Playing presentation can render the
 * same markup without pulling the library store into the guest bundle.
 *
 * Takes the same props as CoverArt (the host's `coverArtId` and
 * `radioFavicon` routes are simply unused here - a guest only ever has a
 * ready URL in `src`). A radio logo asks it to read the backend's own
 * transparency reading off the response; a song cover does not. */
export default {
  name: 'GuestCover',
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
    /** Whether to read the transparent-logo header off the response (radio
     * logos only). */
    transparency: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['transparency', 'loaded'],
  data() {
    return { transparent: false }
  },
  computed: {
    sizeCss(): string {
      return typeof this.size === 'number' ? `${this.size}px` : this.size
    },
  },
  watch: {
    src() {
      this.transparent = false
      if (this.transparency && this.src) void this.checkTransparency(this.src)
    },
  },
  mounted() {
    if (this.transparency && this.src) void this.checkTransparency(this.src)
  },
  methods: {
    /** connect measures the logo (routes/radio.py's _has_transparency) and
     * says so in a header an <img> cannot read; the image itself then comes
     * out of the browser's cache. */
    async checkTransparency(url: string) {
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (url !== this.src) return
        this.transparent = response.headers.get('X-Has-Transparency') === 'true'
        this.$emit('transparency', this.transparent)
      } catch {
        // Shown with a card, as before its reading arrives.
      }
    },
  },
}
</script>

<style scoped>
.guest-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.4);
}

/* A station logo is whatever shape the station made it; cropping one to a
 * square cuts the name off its own logo (see CoverArt's own `contain`). */
.guest-cover--contain {
  object-fit: contain;
}

.guest-cover--transparent {
  background: transparent;
}

.guest-cover__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.guest-cover__img--contain {
  object-fit: contain;
}

.guest-cover__fallback {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
