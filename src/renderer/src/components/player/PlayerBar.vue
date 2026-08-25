<template>
  <v-footer app inset height="88" color="#0B0D13" class="player-bar px-4">
    <div class="player-bar__row" :style="{ '--player-bar-flank-width': flankWidthPx + 'px' }">
      <song-info />
      <control-container />
      <player-toolbar :volume-collapsed="volumeCollapsed" />
    </div>
  </v-footer>
</template>

<script lang="ts">
import SongInfo from './SongInfo.vue'
import ControlContainer from './ControlContainer.vue'
import PlayerToolbar from './PlayerToolbar.vue'

// Below this width, PlayerToolbar.vue drops its volume slider + percentage label
// entirely and folds them into a popover behind the mute icon instead (see
// its own :volume-collapsed prop). Considered having the toolbar visually
// overlap the slider instead of this, but two interactive controls sharing
// the same pixels means whichever is "on top" steals the other's
// clicks/drags — this avoids that outright rather than trying to manage it.
//
// Set comfortably above 1200px (.player-bar__row's own min-width while
// *not* collapsed, see its own comment) — the collapse needs to have
// already happened by the time the row would otherwise be forced that
// narrow, or there'd be a dead zone where the row's still-uncollapsed
// 434px flanks (see flankWidthPx) can't fit but nothing has told it to
// shrink them yet.
const VOLUME_COLLAPSE_BREAKPOINT_PX = 1250

export default {
  name: 'PlayerBar',
  components: { SongInfo, ControlContainer, PlayerToolbar },
  data() {
    return {
      // Driven by barResizeObserver below, off this element's own real
      // rendered width — not a window-width media query, which would stay
      // wrong whenever the sidebar rail's own width changes independently
      // of the window (e.g. expand-on-hover, see DefaultLayout.vue).
      volumeCollapsed: false,
      barResizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    // Both song-info's and toolbar's own grid track (see .player-bar__row's
    // own comment on why they're forced identical, not each sized to its
    // own content) — the shared value is whichever of the two ever needs
    // more room in the *current* state: 434px is PlayerToolbar.vue's own natural
    // width in the widest case with the volume slider still shown
    // (Electron, a song loaded, casting to one device); 300px is what's
    // left needing accommodating once VOLUME_COLLAPSE_BREAKPOINT_PX has
    // already dropped the slider/label, where song-info's own fixed width
    // becomes the wider one instead. A single static number across both
    // states (434px always) would keep exact centering too, but would also
    // silently defeat the collapse's entire reason to exist — the
    // reclaimed space would just sit unused to the left of a now-smaller
    // icon row inside a track that never actually shrank.
    flankWidthPx(): number {
      return this.volumeCollapsed ? 300 : 434
    },
  },
  mounted() {
    this.barResizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width != null) this.volumeCollapsed = width < VOLUME_COLLAPSE_BREAKPOINT_PX
    })
    this.barResizeObserver.observe(this.$el as Element)
  },
  beforeUnmount() {
    this.barResizeObserver?.disconnect()
  },
}
</script>

<style scoped>
/* The 88 in the template's height attribute is mirrored by
 * --beacon-player-bar-height in assets/base.css, which the bar's own
 * popovers are positioned against — keep the two in step. */
.player-bar {
  border-top: 1px solid var(--beacon-hairline);
}

/* A 3-column grid, not flex — song-info and toolbar almost never end up the
 * same width (whether a song is currently loaded alone toggles the star
 * button and the lyrics button, casting to one device adds the
 * device-volume slider, Electron adds the remote-control icon, ...), so
 * centering control-container by giving it the flex-grow leftover space
 * (the old approach) only actually centers it when both side columns
 * happen to match — otherwise it sits wherever the *narrower* side's slack
 * happens to push it, visibly off-center.
 *
 * Both flanks share the exact same width, driven by the
 * --player-bar-flank-width custom property (see the template's own :style
 * binding and flankWidthPx above) — not each sized to its own content.
 * `auto` on each flank independently (tried first) does keep both from
 * ever shrinking, since grid always satisfies non-flexible tracks in full
 * before an `fr` track gets anything, but song-info's own 300px and
 * toolbar's own natural width are almost never equal — control-container
 * still ends up measurably off the bar's own midpoint (up to ~67px, in the
 * widest real mismatch). A shared value is the only way for two
 * *different*-content columns to occupy *identical* track widths, which is
 * what the classic "equal flanks center the middle track by construction"
 * trick actually depends on — flankWidthPx is whichever of the two
 * genuinely needs more room in the *current* state (434px normally,
 * toolbar's own natural width in the widest case with the volume slider
 * still shown; 300px, song-info's own width, once
 * VOLUME_COLLAPSE_BREAKPOINT_PX has already dropped the slider and toolbar
 * no longer needs as much). A single static value across both states would
 * keep exact centering too, but would also silently defeat the collapse's
 * entire reason to exist — the reclaimed space would just sit unused to
 * the left of a now-smaller icon row inside a track that never actually
 * shrank alongside it. The (accepted) visible cost either way: some empty
 * space between song-info's own content and where control-container
 * starts whenever toolbar happens to be the wider flank, where a track
 * sized to its own content alone wouldn't have any.
 *
 * The center track is minmax(var(--control-container-min-width), 1fr), not
 * `auto` — as the row's *only* `fr` track, it's the one grid gives
 * leftover space to (or takes it away from first, down to that same
 * 220px floor ControlContainer.vue/SeekBar.vue also declare, once there
 * isn't enough to go around). Declared here, on the row, rather than only
 * inside ControlContainer.vue — a custom property set on a *child* can't
 * be read back by its own *parent*'s grid-template-columns; this is the
 * one place both directions (this rule, and ControlContainer.vue/
 * SeekBar.vue inheriting the same property downward) can agree on a
 * single number. (Earlier this used a bare 300px here instead, an
 * unrelated leftover from before control-container's own children moved
 * into their own components — center-controls' real natural width was
 * never actually re-measured against it until then, so the two only
 * happened to both "work" because 300 > 220 by coincidence, not by
 * design.) (Also earlier, before minmax(min, 1fr) at all: `auto`, on the
 * theory that grid would size the track off its own content's max-content
 * width — 600px, capped by SeekBar.vue's own max-width. It didn't:
 * percentage widths are excluded from max-content computation entirely
 * per spec, and SongWaveform.vue's canvas is width: 100%, not a fixed
 * length, so that computation had nothing real to resolve against and
 * settled on an arbitrary, viewport-size-dependent value instead, with a
 * real ResizeObserver feedback loop behind it.) On a wide window this
 * *track* keeps growing well past 600px regardless — ControlContainer.vue
 * itself now caps its own width there and re-centers within the leftover
 * track space (see its own comment) rather than filling the whole thing
 * the way it briefly did, with SeekBar.vue's own width: 100% following
 * suit, while CenterControls.vue's own transport buttons stay at their own
 * narrower natural width, centered independently within the same
 * (now-capped) box.
 *
 * min-width is the exact floor where every track is already at its own
 * minimum, in the *collapsed* state — 300 (flank) + 16 gap + 220 (center)
 * + 16 gap + 300 (flank) = 852px (.player-bar's own px-4 padding is
 * separate, added on top of *this* element's box, not part of it; no
 * extra rounding buffer either — this value has to stay exact, a few
 * spare px here is exactly what let the row overflow its own already-
 * this-narrow parent once during testing). Below this, the window itself
 * needs to scroll rather than any piece here visually breaking — the
 * not-collapsed state has its own, larger natural floor
 * (434 + 16 + 220 + 16 + 434 = 1120px), but VOLUME_COLLAPSE_BREAKPOINT_PX
 * is set comfortably above that specifically so collapse has already
 * happened by the time it would otherwise matter. Deliberately on this
 * element, not .player-bar itself — .player-bar is what this component's
 * own ResizeObserver watches to decide that breakpoint, and it needs to
 * keep reporting its real, unclamped width for that to work at all; a
 * min-width there would quietly floor .player-bar's own measured width at
 * this same number, so once the window ever got this narrow the observer
 * could never see anything narrower again. Enforcing the floor one level
 * down instead still stops the row from visibly breaking — .player-bar
 * itself just overflows past its own (now measurably too-narrow) box,
 * which is what actually needs to be scrollable, not clamped. */

.player-bar__row {
  display: grid;
  grid-template-columns:
    var(--player-bar-flank-width) minmax(var(--control-container-min-width), 1fr)
    var(--player-bar-flank-width);
  align-items: center;
  gap: 16px;
  width: 100%;
  min-width: 852px;
  /* CenterControls.vue is a fixed set of five buttons that never changes
   * at runtime, unlike PlayerToolbar.vue's own varying content (see
   * flankWidthPx) — a real ResizeObserver measurement would be pure
   * overhead here, so this is a plain measured constant instead (with a
   * small rounding buffer over the ~212px actually measured). Declared as
   * a custom property, not a bare number inline below, so
   * ControlContainer.vue and SeekBar.vue can inherit this exact same
   * value themselves instead of a second, independently-hardcoded copy
   * that could silently drift from this one. */
  --control-container-min-width: 220px;
}
</style>
