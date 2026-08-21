<template>
  <div class="control-container d-flex flex-column align-center">
    <center-controls />
    <seek-bar />
  </div>
</template>

<script lang="ts">
import CenterControls from './CenterControls.vue'
import SeekBar from './SeekBar.vue'

export default {
  name: 'ControlContainer',
  components: { CenterControls, SeekBar },
}
</script>

<style scoped>
/* Fills its whole grid track (PlayerBar.vue's own center `1fr` column),
 * rather than shrinking to CenterControls.vue's own tight ~212px content
 * width — modeled after how the original (React) Feishin splits this same
 * job between its own two children: the transport buttons stay at their
 * own natural width and get centered within the shared box (flex-column +
 * align-items: center below), while the seek bar underneath deliberately
 * fills nearly all of that same box instead of matching the buttons'
 * width. The two rows are allowed to visibly differ in width — only the
 * *box* itself, not each individual row, needs to be centered in the bar.
 *
 * Explored first: giving this a fixed width exactly matching
 * CenterControls.vue's own measured ~212px (so every row inside it,
 * including SeekBar.vue's own width: 100%, would end up pixel-identical to
 * the buttons row). That's real CSS the browser will happily do, but it
 * was chasing a constraint Feishin's own UI never actually enforces —
 * once seen next to the reference implementation, a seek bar visibly no
 * wider than five small icon buttons reads as a bug in its own right, not
 * a fix. min-width (not width) is what actually belongs here: a floor for
 * when the row gets squeezed, not a ceiling on how wide this can grow when
 * there's room to spare. */
.control-container {
  width: 100%;
  min-width: var(--control-container-min-width, 220px);
  /* A ceiling this time, not the min-width floor above — filling the
   * *entire* 1fr track on a wide monitor (1000px+) reads as absurdly wide
   * for a transport-buttons-and-seek-bar cluster, not "using the space
   * well". Capped here, directly on this box, rather than via the grid
   * track's own sizing — that was tried once already and failed for an
   * unrelated CSS-spec reason (see PlayerBar.layout.browser.test.ts's
   * header comment on the `auto`-track-sizing attempt); the track itself
   * stays a plain 1fr, this element alone just declines to use all of it.
   * justify-self: center re-centers the (now possibly narrower-than-its-
   * track) box within that track — grid's own default stretch alignment
   * degrades to start (left) once an item's max-width caps below the
   * space actually available to it. */
  max-width: 600px;
  justify-self: center;
}
</style>
