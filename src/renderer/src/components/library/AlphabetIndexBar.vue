<template>
  <div
    class="alphabet-index-bar"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <button
      v-for="letter in letters"
      :key="letter"
      type="button"
      class="alphabet-index-letter"
      :class="{ 'alphabet-index-letter--disabled': !available.has(letter) }"
      :disabled="!available.has(letter)"
      :tabindex="available.has(letter) ? 0 : -1"
      @click="$emit('select', letter)"
    >
      {{ letter }}
    </button>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

// '#' first (not last) — same convention Subsonic's own getArtists.view
// index uses for non-letter-leading names, and matches where a thumb
// naturally lands first reaching for the top of the bar.
const LETTERS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))]

export default {
  name: 'AlphabetIndexBar',
  props: {
    // Letters (already uppercased, '#' for anything not starting with A-Z)
    // that have at least one match in the list right now. Letters outside
    // this set still render, just greyed out and inert — keeping the bar's
    // shape and every other letter's position stable while a filter query
    // narrows what's available, instead of the whole bar reflowing.
    available: {
      type: Object as PropType<Set<string>>,
      required: true,
    },
  },
  emits: ['select'],
  data() {
    return {
      letters: LETTERS,
      dragging: false,
    }
  },
  methods: {
    onPointerDown(event: PointerEvent) {
      this.dragging = true
      // Keeps receiving pointermove even once the cursor drifts off the
      // (narrow, 20px-ish) bar itself mid-drag — without this a fast scrub
      // that strays a few pixels sideways stops tracking entirely instead
      // of continuing to jump letters.
      ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
      this.selectFromPoint(event.clientX, event.clientY)
    },
    onPointerMove(event: PointerEvent) {
      if (this.dragging) this.selectFromPoint(event.clientX, event.clientY)
    },
    onPointerUp() {
      this.dragging = false
    },
    // Lets one press-and-drag down the bar scrub through letters
    // continuously, like iOS/macOS Contacts' own index bar, instead of
    // needing a fresh tap per letter. elementFromPoint (not the move
    // event's own target, which stays pinned to whatever element pointer
    // capture was set on) is what makes that work.
    selectFromPoint(x: number, y: number) {
      const letter = document
        .elementFromPoint(x, y)
        ?.closest('.alphabet-index-letter')
        ?.textContent?.trim()
      if (letter && this.available.has(letter)) this.$emit('select', letter)
    },
  },
}
</script>

<style scoped>
/* Floating pill along the right edge — same visual language as SongTable's
 * own floating .selection-bar (fixed, pill-shaped, hairline border). Docked
 * to viewport middle rather than anchored to the grid itself: this sits
 * next to grids of varying height across Albums/Artists, and a fixed mid-
 * screen position is the one spot a thumb reaches the same way regardless. */
.alphabet-index-bar {
  position: fixed;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 3px;
  border-radius: 9999px;
  background: #1a1d27;
  border: 1px solid var(--beacon-hairline);
  z-index: 5;
  /* Prevents the browser's own touch-scroll/zoom gestures from hijacking a
   * drag that starts on the bar (relevant on the mobile web UI's desktop-
   * width breakpoint / any touch-capable display running Beacon). */
  touch-action: none;
}

.alphabet-index-letter {
  all: unset;
  cursor: pointer;
  font-size: 10px;
  line-height: 1.5;
  padding: 0 5px;
  text-align: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.alphabet-index-letter:hover:not(.alphabet-index-letter--disabled),
.alphabet-index-letter:focus-visible:not(.alphabet-index-letter--disabled) {
  color: rgb(var(--v-theme-primary));
}

.alphabet-index-letter--disabled {
  cursor: default;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 20%, transparent);
}
</style>
