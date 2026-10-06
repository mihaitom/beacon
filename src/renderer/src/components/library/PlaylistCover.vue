<template>
  <div class="playlist-cover" :style="{ width: `${size}px`, height: `${size}px` }">
    <v-skeleton-loader
      v-if="loading && !covers.length"
      type="image"
      class="playlist-cover__skeleton"
    />
    <cover-art
      v-else-if="!covers.length"
      :cover-art-id="null"
      :size="size"
      :fallback-icon="fallbackIcon"
    />
    <template v-else>
      <!-- Two stacked layers, as for the blurred backdrops (see
       - services/crossfadeBackdrop.ts): the next cover loads on the hidden
       - one and only takes over once it has arrived, so the fade always
       - lands on an image rather than on a skeleton. -->
      <cover-art
        v-for="(id, i) in layers"
        :key="i"
        :cover-art-id="id"
        :size="size"
        :fallback-icon="fallbackIcon"
        class="playlist-cover__layer"
        :class="{ 'playlist-cover__layer--active': i === active }"
        @loaded="onLoaded(i, $event)"
      />
    </template>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'

/** Whether the reader has asked for less motion. Read per tick rather than
 * once, so changing the setting takes effect without a reload. */
function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** A playlist's artwork made from its own albums: one cover at a time,
 * cross-fading to the next while `cycling` is on. */
export default {
  name: 'PlaylistCover',
  components: { CoverArt },
  props: {
    /** The cover ids to show, in order. Empty shows the fallback icon - or
     * a skeleton while `loading`. */
    covers: { type: Array as PropType<string[]>, required: true },
    loading: { type: Boolean, default: false },
    size: { type: Number, required: true },
    cycling: { type: Boolean, default: false },
    intervalMs: { type: Number, default: 2500 },
    fallbackIcon: { type: String, default: 'mdi-playlist-music' },
  },
  emits: {
    /** The cover now on screen, for a host that paints something from it. */
    change: (id: string) => typeof id === 'string',
  },
  data() {
    return {
      layers: [null, null] as (string | null)[],
      loaded: [false, false],
      active: 0,
      /** Index into `covers` of the cover on the active layer. */
      position: 0,
      /** Index into `covers` of the cover loading on the hidden layer. */
      upcoming: -1,
      timer: null as number | null,
    }
  },
  watch: {
    // A new summary (the playlist was edited, or it just arrived) starts
    // over from its first cover rather than fading in from a stale one.
    covers: {
      handler(next: string[], previous: string[] | undefined) {
        if (previous && next[0] === previous[0] && next.length === previous.length) return
        this.layers = [next[0] ?? null, null]
        this.loaded = [false, false]
        this.active = 0
        this.position = 0
        this.upcoming = -1
      },
      immediate: true,
    },
    cycling: {
      handler(on: boolean) {
        this.stop()
        if (on) this.timer = window.setInterval(this.advance, this.intervalMs)
      },
      immediate: true,
    },
  },
  beforeUnmount() {
    this.stop()
  },
  methods: {
    stop(): void {
      if (this.timer !== null) window.clearInterval(this.timer)
      this.timer = null
    },
    /** Puts the next cover on the hidden layer. One that has not arrived by
     * the next tick is passed over - a cover that failed to load would
     * otherwise stop the cycle on the one before it for good. */
    advance(): void {
      if (this.covers.length < 2 || document.hidden || reducedMotion()) return
      const from = this.upcoming >= 0 ? this.upcoming : this.position
      const next = (from + 1) % this.covers.length
      const hidden = 1 - this.active
      this.upcoming = next
      if (this.layers[hidden] === this.covers[next] && this.loaded[hidden]) {
        this.show(hidden)
        return
      }
      this.layers[hidden] = this.covers[next] ?? null
      this.loaded[hidden] = false
    },
    onLoaded(layer: number, src: string | null): void {
      this.loaded[layer] = src !== null
      if (src === null) return
      if (layer === this.active) {
        this.$emit('change', this.layers[layer] as string)
      } else if (this.upcoming >= 0 && this.layers[layer] === this.covers[this.upcoming]) {
        this.show(layer)
      }
    },
    show(layer: number): void {
      this.active = layer
      this.position = this.upcoming
      this.upcoming = -1
      this.$emit('change', this.layers[layer] as string)
    },
  },
}
</script>

<style scoped>
.playlist-cover {
  position: relative;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
}

.playlist-cover__layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.6s ease;
}

.playlist-cover__layer--active {
  opacity: 1;
}

.playlist-cover__skeleton {
  width: 100%;
  height: 100%;
  background: transparent;
}
</style>
