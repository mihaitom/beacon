<template>
  <div ref="sentinel" class="sticky-filter-sentinel" />
  <div
    ref="box"
    class="sticky-filter"
    :class="{ 'sticky-filter--fade': fade && isStuck }"
    :style="{ zIndex }"
  >
    <slot />
  </div>
</template>

<script lang="ts">
/**
 * Shared sticky wrapper for the filter field below each library view's hero
 * header — sticks flush against the app-bar with the visual gap created via
 * padding (not a `top` offset), so nothing scrolls through it transparently.
 * Also centralizes the "stuck" detection needed for the bottom fade: a
 * pseudo-element that's always positioned there would overlap whatever
 * comes right after it even before any scrolling happens (the fade would be
 * visible on the very first row on initial load), so it only renders once
 * a 1px sentinel placed just above this box has scrolled out of view —
 * which happens exactly when the box itself clamps to its sticky `top`.
 */
export default {
  name: 'StickyFilter',
  props: {
    // SongsView passes 3 so it stacks above SongTable's own sticky column
    // header (z-index 2, see SongTable.vue) — everywhere else the filter
    // has nothing sticky below it to out-stack, so the default is enough.
    zIndex: { type: Number, default: 2 },
    // Off for SongsView: SongTable's own sticky column header sits
    // immediately below with its own opaque background, not scrolling
    // content, so there's nothing that would need to fade out underneath.
    fade: { type: Boolean, default: true },
  },
  emits: ['resize'],
  data() {
    return {
      isStuck: false,
      intersectionObserver: null as IntersectionObserver | null,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  mounted() {
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.isStuck = entry ? !entry.isIntersecting : false
    })
    this.intersectionObserver.observe(this.$refs.sentinel as Element)

    // getBoundingClientRect() (not the entry's own contentRect, which
    // excludes padding) so consumers needing the box's full footprint
    // (SongsView, stacking SongTable's column header right below it) get
    // padding included, not just the inner content's height.
    this.resizeObserver = new ResizeObserver((entries) => {
      this.$emit('resize', entries[0]?.target.getBoundingClientRect().height ?? 0)
    })
    this.resizeObserver.observe(this.$refs.box as Element)
  },
  beforeUnmount() {
    this.intersectionObserver?.disconnect()
    this.resizeObserver?.disconnect()
  },
}
</script>

<style scoped>
.sticky-filter-sentinel {
  height: 1px;
}

.sticky-filter {
  position: sticky;
  top: var(--v-layout-top, 0px);
  background: rgb(var(--v-theme-background));
  padding-top: 12px;
  padding-bottom: 16px;
  /* Forces its own compositing layer — without this, Chromium sometimes
   * renders position:sticky content with a faint 1px wobble while scrolling
   * (the compositor and main thread disagree on the sub-pixel offset for a
   * frame or two). */
  transform: translateZ(0);
}

/* Soft fade right where scrolled-past content disappears under the sticky
 * filter, instead of clipping abruptly against its opaque background. Only
 * shown once actually stuck (see isStuck above). */
.sticky-filter--fade::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -24px;
  height: 24px;
  background: linear-gradient(to bottom, rgb(var(--v-theme-background)), transparent);
  pointer-events: none;
}
</style>
