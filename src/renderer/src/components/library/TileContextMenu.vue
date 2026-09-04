<template>
  <!-- Detached from any activator element — :target takes raw [x, y]
   - coordinates, so the menu appears where the pointer is rather than
   - against the element, and a tile needs no menu button of its own.
   -
   - scroll-strategy="close": the default ("reposition") keeps an open menu
   - glued to its target while the page scrolls underneath, which for a menu
   - anchored to a *point* means it slides around over unrelated content.
   - Scrolling now dismisses it instead, the way a desktop context menu
   - behaves.
   -
   - Not "block", which was tried first and is what a dialog uses: it makes
   - the document `position: fixed` for as long as the overlay is open, so
   - window.scrollY collapses to 0 and every element below the fold is
   - clipped away. In a library grid that meant each cover's own lazy-load
   - observer (see CoverArt.vue) saw its tile leave the viewport and drop
   - its image, and the tiles further down the page visibly flickered on
   - every right-click while the menu itself never appeared. Reported live
   - 2026-09-04; see TileContextMenu.layout.browser.test.ts, which is in a
   - real browser precisely because none of that is observable in jsdom. -->
  <v-menu v-model="menuOpen" :target="menuTarget" scroll-strategy="close">
    <v-list density="compact">
      <slot />
    </v-list>
  </v-menu>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import { nextContextMenuId } from '@/services/contextMenu'

/**
 * The right-click menu shared by every library tile and row — the menu
 * state, its position, and the one-open-at-a-time bookkeeping (see
 * services/contextMenu.ts). What is *in* it comes from the default slot, so
 * each caller writes its own actions and nothing else.
 *
 * A menu rather than more click targets on the tile itself: a tile's click
 * is already the thing it is for (opening the album, playing the playlist),
 * and everything else it can do has to live somewhere that costs no space.
 */
export default {
  name: 'TileContextMenu',
  props: {
    /** Whether there is anything worth opening a menu for. A tile with no
     * actions available to it (an empty playlist, artwork that doesn't
     * exist) should not answer a right-click with an empty list. */
    enabled: { type: Boolean, default: true },
  },
  data() {
    return {
      menuOpen: false,
      menuTarget: [0, 0] as [number, number],
      menuId: nextContextMenuId(),
    }
  },
  mounted() {
    // The imported bus rather than this.$emitter: that global is installed
    // by main.ts, and tiles get mounted in plenty of component tests that
    // never install it.
    emitter.on('contextMenuOpened', this.onOtherMenuOpened)
  },
  beforeUnmount() {
    emitter.off('contextMenuOpened', this.onOtherMenuOpened)
  },
  methods: {
    /** Called by the tile from its own @contextmenu (or from a "..."
     * button's click, which carries usable coordinates too). */
    open(event: MouseEvent): void {
      if (!this.enabled) return
      this.menuTarget = [event.clientX, event.clientY]
      this.menuOpen = true
      emitter.emit('contextMenuOpened', this.menuId)
    },
    close(): void {
      this.menuOpen = false
    },
    onOtherMenuOpened(id: number): void {
      if (id !== this.menuId) this.menuOpen = false
    },
  },
}
</script>
