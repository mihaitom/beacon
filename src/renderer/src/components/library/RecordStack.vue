<template>
  <div
    class="record-stack"
    :class="{ 'record-stack--browsing': browsing }"
    :style="{
      width: `${size}px`,
      height: `${size + (depth - 1) * rise}px`,
      '--record-rise': `${rise}px`,
    }"
    aria-hidden="true"
  >
    <!-- Records standing in a crate, seen from the front: the first whole,
     - the ones behind it only by their top edges. While `browsing`, the
     - front record is flipped forward every beat and the others move up
     - one place, the next one coming in at the back - flipping through.
     - The next one already waits exactly behind the last, so it is
     - uncovered rather than faded in.
     -
     - Keyed by their place in an endless run of records, not by cover id:
     - with fewer covers than places the same cover comes round again, and
     - that has to be a new record entering at the back, not the old one
     - sliding through the others to get there. -->
    <transition-group name="record">
      <div
        v-for="record in records"
        :key="record.key"
        class="record-stack__record"
        :class="{ 'record-stack__record--waiting': record.waiting }"
        :style="{ '--depth': Math.min(record.depth, depth - 1), '--layer': record.depth }"
      >
        <cover-art :cover-art-id="record.coverArtId" :size="size" :fallback-icon="fallbackIcon" />
      </div>
    </transition-group>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'

/** How long one record stays at the front while browsing, and how long the
 * first one waits - long enough that a pointer only passing over the stack
 * does not set it going. */
const BEAT_MS = 1100
const FIRST_BEAT_MS = 350

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export default {
  name: 'RecordStack',
  components: { CoverArt },
  props: {
    /** Cover art ids, front first. Fewer than `depth` fill the back with
     * empty sleeves rather than showing a half-empty crate. */
    covers: { type: Array as PropType<string[]>, default: () => [] },
    /** A record's edge, in px. */
    size: { type: Number, required: true },
    /** How many records stand in the stack. */
    depth: { type: Number, default: 4 },
    /** How much higher each record behind stands, in px. */
    rise: { type: Number, default: 15 },
    browsing: { type: Boolean, default: false },
    fallbackIcon: { type: String, default: 'mdi-album' },
  },
  emits: {
    /** The cover now at the front, for a host that shows or uses it. */
    change: (id: string | null) => id === null || typeof id === 'string',
  },
  data() {
    return {
      /** How many records have been flipped past so far. */
      offset: 0,
      timer: null as number | null,
    }
  },
  computed: {
    records(): { key: number; depth: number; waiting: boolean; coverArtId: string | null }[] {
      return Array.from({ length: this.depth + 1 }, (_, depth) => {
        const key = this.offset + depth
        const coverArtId = this.covers.length ? this.covers[key % this.covers.length]! : null
        // Before the first flip a short list shows its own empties; once
        // flipping, it comes round again instead.
        const empty = this.offset === 0 && key >= this.covers.length
        return { key, depth, waiting: depth === this.depth, coverArtId: empty ? null : coverArtId }
      })
    },
    front(): string | null {
      return this.records[0]?.coverArtId ?? null
    },
  },
  watch: {
    browsing: {
      handler(on: boolean) {
        this.stop()
        if (on && this.covers.length > 1 && !reducedMotion()) {
          this.timer = window.setTimeout(this.flip, FIRST_BEAT_MS)
        }
      },
      immediate: true,
    },
    // A new list (the playlist was edited, its summary just arrived)
    // starts over from its own first cover.
    covers(next: string[], previous: string[]) {
      if (next[0] !== previous[0] || next.length !== previous.length) this.offset = 0
    },
    front(id: string | null) {
      this.$emit('change', id)
    },
  },
  beforeUnmount() {
    this.stop()
  },
  methods: {
    stop(): void {
      if (this.timer !== null) window.clearTimeout(this.timer)
      this.timer = null
    },
    flip(): void {
      if (!document.hidden) this.offset++
      this.timer = window.setTimeout(this.flip, BEAT_MS)
    },
  },
}
</script>

<style scoped>
.record-stack {
  position: relative;
  flex-shrink: 0;
  perspective: 600px;
}

/* Each record behind stands --record-rise higher and is a little smaller
 * and darker, so its top edge shows above the one in front. */
.record-stack__record {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: calc(10 - var(--layer));
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.45);
  transform-origin: 50% 100%;
  transform: translateY(calc(var(--depth) * var(--record-rise) * -1))
    scale(calc(1 - var(--depth) * 0.04));
  filter: brightness(calc(1 - var(--depth) * 0.16));
  transition:
    transform 0.45s cubic-bezier(0.2, 0.7, 0.2, 1),
    filter 0.45s ease;
}

/* Browsing: the records stand a little further apart, so the flip has room
 * to show. */
.record-stack--browsing .record-stack__record {
  transform: translateY(calc(var(--depth) * var(--record-rise) * -1.35))
    scale(calc(1 - var(--depth) * 0.04));
  filter: brightness(calc(1 - var(--depth) * 0.12));
}

/* The front record is flipped forward, towards the reader, about its
 * bottom edge - the way a hand goes through a crate. Three classes deep: the
 * browsing rule above sets the same transform with two, and won, which
 * left the record fading out on the spot. */
.record-stack .record-stack__record.record-leave-active {
  transition:
    transform 0.55s cubic-bezier(0.45, 0, 0.55, 1),
    opacity 0.25s ease 0.3s;
  z-index: 11;
}

.record-stack .record-stack__record.record-leave-to {
  transform: rotateX(-82deg);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .record-stack__record,
  .record-leave-active {
    transition: none;
  }
}
</style>
