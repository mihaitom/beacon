<template>
  <div class="control-container">
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
 * width. The two rows inside are sized independently on purpose: the
 * transport buttons keep their own natural width and are centered within
 * the shared box (flex-column + align-items: center below), while the seek
 * bar underneath fills nearly all of that box. Only the *box* needs to be
 * centered in the bar, not each row within it.
 *
 * Explored first: giving this a fixed width exactly matching
 * CenterControls.vue's own measured ~212px (so every row inside it,
 * including SeekBar.vue's own width: 100%, would end up pixel-identical to
 * the buttons row). That's real CSS the browser will happily do, but the
 * result reads as broken: a seek bar no wider than five small icon buttons
 * looks like a bug in its own right, not like alignment. A seek bar is a
 * target you aim at, and shrinking it to the width of the row above costs
 * real precision for a symmetry nobody asked for. min-width (not width) is
 * what belongs here: a floor for when the row gets squeezed, not a ceiling
 * on how wide this can grow when there's room to spare. */
.control-container {
  /* The two rows keep their own natural widths and are centered within
   * this box — see the note above on why only the box is centered in the
   * bar, not each row within it. */
  display: flex;
  flex-direction: column;
  align-items: center;
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
