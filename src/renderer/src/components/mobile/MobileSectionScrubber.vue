<template>
  <div
    class="mobile-scrubber"
    :class="{
      'mobile-scrubber--shown': shown,
      'mobile-scrubber--open': open,
    }"
    :style="geometry"
  >
    <!-- The phone's take on the desktop letter bar (AlphabetIndexBar.vue),
       - whose 10px letters in a 20px column are no target for a thumb. Out of
       - the way until the list moves: scrolling brings out a grip on the right
       - edge, the Android/Contacts fast-scroll pattern. Dragging the grip opens
       - the rail and scrubs section by section; a tap opens it to pick from.
       - Vuetify has no fast scroller of its own (v-virtual-scroll ships none),
       - which is why this is ours. -->
    <div v-if="open" class="mobile-scrubber__scrim" @pointerdown="close" />

    <div
      ref="rail"
      class="mobile-scrubber__rail"
      :aria-hidden="!open"
      @pointerdown="onRailDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <button
        v-for="section in sections"
        :key="section"
        type="button"
        class="mobile-scrubber__section"
        :class="{
          'mobile-scrubber__section--off': !available.has(section),
          'mobile-scrubber__section--here': section === current,
        }"
        :disabled="!available.has(section)"
        :tabindex="open && available.has(section) ? 0 : -1"
        @click="pick(section)"
      >
        {{ label(section) }}
      </button>
    </div>

    <!-- The one loud thing: where the thumb is, shown beside it, since the
       - thumb itself covers the rail. -->
    <div
      v-if="scrubbing && current"
      class="mobile-scrubber__bubble"
      :style="{ top: `${gripTop + GRIP_HEIGHT / 2}px` }"
      aria-hidden="true"
    >
      {{ label(current) }}
    </div>

    <button
      type="button"
      class="mobile-scrubber__grip"
      :style="{ top: `${gripTop}px` }"
      :aria-label="$t('library.jumpToSection')"
      :aria-expanded="open"
      @pointerdown="onGripDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <span v-if="current" class="mobile-scrubber__grip-label">{{ label(current) }}</span>
      <v-icon v-else icon="mdi-unfold-more-horizontal" size="20" />
    </button>
  </div>
</template>

<script lang="ts">
import { markRaw, type PropType } from 'vue'

/** The grip: a thumb's width, a little taller than wide so it reads as
 * something to pull rather than a button. */
const GRIP_HEIGHT = 52
/** How long the grip stays after the list stops moving. */
const LINGER_MS = 1500
/** Under this much travel a press is a tap, not a drag. */
const TAP_SLOP_PX = 8
/** Clear of the bars and of each end of the pane. */
const EDGE_GAP = 12

export default {
  name: 'MobileSectionScrubber',
  props: {
    sections: { type: Array as PropType<string[]>, required: true },
    available: { type: Object as PropType<Set<string>>, required: true },
    label: {
      type: Function as PropType<(section: string) => string>,
      default: (section: string) => section,
    },
    /** The section on screen, from the list. */
    active: { type: String as PropType<string | null>, default: null },
    /** What covers the top of the pane - the sticky controls - so the rail
     * starts under them. */
    topInset: { type: Number, default: 0 },
  },
  emits: ['select'],
  data() {
    return {
      GRIP_HEIGHT,
      moving: false,
      scrubbing: false,
      open: false,
      progress: 0,
      dragTop: null as number | null,
      picked: null as string | null,
      pressY: 0,
      travelled: 0,
      pane: null as HTMLElement | null,
      paneTop: 0,
      paneBottom: 0,
      viewportHeight: window.innerHeight,
      lingerTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    shown(): boolean {
      return this.moving || this.scrubbing || this.open
    },
    current(): string | null {
      return this.scrubbing || this.open ? (this.picked ?? this.active) : this.active
    },
    railTop(): number {
      return this.paneTop + this.topInset + EDGE_GAP
    },
    railHeight(): number {
      return Math.max(GRIP_HEIGHT, this.viewportHeight - this.paneBottom - EDGE_GAP - this.railTop)
    },
    gripTop(): number {
      const travel = this.railHeight - GRIP_HEIGHT
      if (this.dragTop !== null) {
        return this.railTop + Math.min(Math.max(this.dragTop - GRIP_HEIGHT / 2, 0), travel)
      }
      return this.railTop + this.progress * travel
    },
    geometry(): Record<string, string> {
      return { '--rail-top': `${this.railTop}px`, '--rail-height': `${this.railHeight}px` }
    },
  },
  mounted() {
    // Raw: a reactive proxy of a DOM element is no element to listen on.
    const pane = document.querySelector<HTMLElement>('.v-main')
    this.pane = pane ? markRaw(pane) : null
    this.measure()
    this.pane?.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.measure)
  },
  beforeUnmount() {
    this.pane?.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.measure)
    clearTimeout(this.lingerTimer)
  },
  methods: {
    /** Where the pane's content starts and ends between the app bar and
     * the tab and player bars, which Vuetify gives it as padding. */
    measure() {
      this.readInsets()
      this.onScroll()
    },
    readInsets() {
      this.viewportHeight = window.innerHeight
      if (!this.pane) return
      const style = getComputedStyle(this.pane)
      this.paneTop = parseFloat(style.paddingTop) || 0
      this.paneBottom = parseFloat(style.paddingBottom) || 0
    },
    onScroll() {
      const pane = this.pane
      if (!pane) return
      const room = pane.scrollHeight - pane.clientHeight
      this.progress = room > 0 ? Math.min(1, Math.max(0, pane.scrollTop / room)) : 0
      // A jump the scrubber made itself scrolls too; that is no reason to
      // bring the grip out again once it has been put away.
      if (this.scrubbing || this.open) return
      if (pane.scrollTop <= 0) return
      // The bars can have settled since mount (the player bar comes and
      // goes); read them again each time the grip comes out.
      if (!this.moving) this.readInsets()
      this.moving = true
      this.linger()
    },
    linger() {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = setTimeout(() => {
        this.moving = false
      }, LINGER_MS)
    },
    onGripDown(event: PointerEvent) {
      this.start(event)
    },
    onRailDown(event: PointerEvent) {
      if (!this.open) return
      this.start(event)
      this.scrubTo(event.clientY)
    },
    start(event: PointerEvent) {
      ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
      clearTimeout(this.lingerTimer)
      this.scrubbing = true
      this.pressY = event.clientY
      this.travelled = 0
      this.picked = this.active
    },
    onMove(event: PointerEvent) {
      if (!this.scrubbing) return
      this.travelled = Math.max(this.travelled, Math.abs(event.clientY - this.pressY))
      if (this.travelled < TAP_SLOP_PX) return
      this.open = true
      this.scrubTo(event.clientY)
    },
    onUp() {
      if (!this.scrubbing) return
      const tapped = this.travelled < TAP_SLOP_PX
      this.scrubbing = false
      this.dragTop = null
      // A tap on the grip leaves the rail open to pick from; a drag closes
      // it again where the thumb let go.
      if (tapped) {
        this.open = !this.open
        return
      }
      this.open = false
      this.moving = true
      this.linger()
    },
    /** The section under the thumb, or the nearest one the list has: a
     * greyed letter is not a place to land, but sliding over it must not
     * stall the scrub either. */
    scrubTo(clientY: number) {
      this.dragTop = clientY - this.railTop
      const fraction = Math.min(Math.max(this.dragTop / this.railHeight, 0), 0.9999)
      const at = Math.floor(fraction * this.sections.length)
      const section = this.nearestAvailable(at)
      if (section) this.pick(section)
    },
    nearestAvailable(at: number): string | null {
      for (let step = 0; step < this.sections.length; step++) {
        for (const index of [at + step, at - step]) {
          const section = this.sections[index]
          if (section !== undefined && this.available.has(section)) return section
        }
      }
      return null
    },
    pick(section: string) {
      if (section === this.picked && this.scrubbing) return
      this.picked = section
      this.$emit('select', section)
      // A tick under the thumb for each section passed, where the phone
      // can (Android; iOS gives the web no haptics).
      if (this.scrubbing) navigator.vibrate?.(6)
    },
    close() {
      this.open = false
      this.picked = null
      this.moving = true
      this.linger()
    },
  },
}
</script>

<style scoped>
.mobile-scrubber {
  position: fixed;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

.mobile-scrubber__scrim {
  position: absolute;
  inset: 0;
  pointer-events: auto;
}

/* The rail: a surface panel down the right edge, only while open. Its
 * sections share the height evenly, so the whole rail is the scrub area
 * however few there are. */
.mobile-scrubber__rail {
  position: absolute;
  top: var(--rail-top);
  right: 6px;
  height: var(--rail-height);
  width: 48px;
  display: flex;
  flex-direction: column;
  padding: 6px 0;
  border-radius: 24px;
  background: rgb(var(--v-theme-surface-bright));
  border: 1px solid var(--beacon-hairline);
  opacity: 0;
  transition: opacity 0.2s ease;
  touch-action: none;
}

.mobile-scrubber--open .mobile-scrubber__rail {
  opacity: 1;
  pointer-events: auto;
  transition-duration: 0.3s;
}

.mobile-scrubber__section {
  all: unset;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.mobile-scrubber__section--off {
  color: rgba(var(--v-theme-on-surface), 0.22);
}

.mobile-scrubber__section--here {
  color: rgb(var(--v-theme-primary));
}

/* The grip rides the right edge at the list's scroll position. */
.mobile-scrubber__grip {
  all: unset;
  position: absolute;
  right: 6px;
  width: 48px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 26px;
  background: rgb(var(--v-theme-surface-bright));
  border: 1px solid var(--beacon-hairline);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  color: rgb(var(--v-theme-on-surface));
  opacity: 0;
  transform: translateX(12px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  touch-action: none;
}

.mobile-scrubber--shown .mobile-scrubber__grip {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-duration: 0.3s;
}

.mobile-scrubber--open .mobile-scrubber__grip {
  border-color: rgba(var(--v-theme-primary), 0.6);
}

.mobile-scrubber__grip-label {
  font-size: 0.85rem;
  font-weight: 700;
  white-space: nowrap;
}

/* Beside the thumb, not under it: 72px of amber with the section in it,
 * far enough left of the rail for a right thumb not to cover it. */
.mobile-scrubber__bubble {
  position: absolute;
  right: 76px;
  min-width: 72px;
  height: 72px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translateY(-50%);
  border-radius: 36px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  font-size: 1.9rem;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
}

@media (prefers-reduced-motion: reduce) {
  .mobile-scrubber__rail,
  .mobile-scrubber__grip {
    transition: none;
  }
}
</style>
