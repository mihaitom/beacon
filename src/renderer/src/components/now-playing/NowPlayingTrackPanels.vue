<template>
  <transition-group
    name="next-up"
    tag="div"
    class="now-playing__panels"
    :class="{
      'now-playing__panels--corner': artworkHidden,
      'now-playing__panels--compact': compact,
    }"
    @before-leave="lockLeaveWidth"
  >
    <div
      v-for="panel in panels"
      :key="panel.key"
      class="now-playing__panel"
      :class="{ 'now-playing__panel--chevrons': panel.kind === 'chevrons' }"
      :style="panel.kind === 'chevrons' ? { color: `rgb(${visualizerColor})` } : undefined"
    >
      <template v-if="panel.kind === 'chevrons'">
        <v-icon
          icon="mdi-chevron-right"
          :size="compact ? 30 : 44"
          class="now-playing__next-up-chevron"
        />
        <v-icon
          icon="mdi-chevron-right"
          :size="compact ? 30 : 44"
          class="now-playing__next-up-chevron now-playing__next-up-chevron--second"
        />
      </template>
      <template v-else>
        <cover-art
          v-if="artworkHidden && panel.song"
          :cover-art-id="panel.song.coverArtId"
          :size="miniArtSize || 72"
          class="cover-shadow now-playing__mini-art"
        />
        <div ref="info" class="now-playing__info">
          <div class="eyebrow-label">{{ panel.eyebrow }}</div>
          <h1 class="detail-title now-playing__title">{{ panel.title }}</h1>
          <!-- A link only where there is an artist page to land on. The
           - mobile shell has none (its library tab plays an album rather than
           - opening one), and the desktop view rendered inside it is a table
           - with no phone layout and nothing to get back with. -->
          <router-link
            v-if="panel.song && !compact"
            :to="`/artists/${panel.song.artistId}`"
            class="text-title-large text-medium-emphasis now-playing__artist-link"
          >
            {{ panel.song.artist }}
          </router-link>
          <div
            v-else-if="panel.song"
            class="text-title-large text-medium-emphasis now-playing__artist-label"
          >
            {{ panel.song.artist }}
          </div>
          <!-- Station name, not the ICY tag — swapped with the title above so
           - the tag (what's actually playing right now) is the prominent
           - label and the station is the secondary one, same as SongInfo.vue's
           - own player-bar label for consistency. Only shown once there's a
           - tag to go with it. -->
          <div
            v-else-if="panel.radioTag"
            class="text-title-large text-medium-emphasis now-playing__radio-tag"
          >
            {{ panel.radioTag }}
          </div>
          <div v-else class="text-title-large text-medium-emphasis" />
          <!-- Each shell to its own album page - see
           - views/mobile/MobileAlbumDetailView.vue. -->
          <router-link
            v-if="panel.song"
            :to="compact ? `/m/albums/${panel.song.albumId}` : `/albums/${panel.song.albumId}`"
            class="text-body-medium text-medium-emphasis now-playing__album-link"
          >
            {{ panel.song.album }}
          </router-link>
        </div>
      </template>
    </div>
  </transition-group>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import type { NowPlayingPanel } from '@/components/now-playing/types'

export default {
  name: 'NowPlayingTrackPanels',
  components: { CoverArt },
  props: {
    panels: {
      type: Array as () => NowPlayingPanel[],
      required: true,
    },
    artworkHidden: {
      type: Boolean,
      default: false,
    },
    compact: {
      type: Boolean,
      default: false,
    },
    visualizerColor: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      // The hidden-artwork corner shows a small cover whose height matches
      // the track text beside it — measured, since that block grows and
      // shrinks with the title. See observeInfo()/measureInfo().
      infoObserver: null as ResizeObserver | null,
      miniArtSize: 0,
    }
  },
  watch: {
    // The panels are keyed by song, so the current panel's info element is
    // replaced on every track change — the observer has to be re-pointed at
    // the new one.
    panels: {
      handler() {
        void this.$nextTick(() => this.observeInfo())
      },
    },
  },
  mounted() {
    void this.$nextTick(() => this.observeInfo())
  },
  beforeUnmount() {
    this.infoObserver?.disconnect()
  },
  methods: {
    /** (Re)points the info observer at the track-text block. */
    observeInfo(): void {
      if (!this.infoObserver) {
        this.infoObserver = new ResizeObserver(() => this.measureInfo())
      }
      this.infoObserver.disconnect()
      const info = this.currentInfoEl()
      if (info) {
        this.infoObserver.observe(info)
        this.measureInfo()
      }
    },
    /** The current panel's info block. `ref="info"` sits inside the panels
     * v-for, so `$refs.info` is an array in DOM order; the current panel is
     * the first song panel (see the parent's cornerPanels). */
    currentInfoEl(): HTMLElement | undefined {
      const refs = this.$refs.info as HTMLElement | HTMLElement[] | undefined
      const list = Array.isArray(refs) ? refs : refs ? [refs] : []
      return list[0]
    },
    /** The hidden-artwork corner's mini cover is square at the track text's
     * own height, so it lines up with the labels instead of sitting at a
     * size of its own. */
    measureInfo(): void {
      const info = this.currentInfoEl()
      if (info) this.miniArtSize = Math.round(info.getBoundingClientRect().height)
    },
    /** Locks a leaving panel's width before it is taken out of the flow (see
     * the next-up leave class), so it fades at the size it had rather than
     * collapsing to its content. */
    lockLeaveWidth(el: Element): void {
      ;(el as HTMLElement).style.width = `${el.getBoundingClientRect().width}px`
    },
  },
}
</script>

<style scoped>
.now-playing__panels {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.now-playing__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* With the artwork hidden each panel is a bottom-left glass corner: the
 * small cover beside the track text. The current one, then - near the end
 * of a track - animated chevrons and the next one to its right. */
.now-playing__panels--corner {
  flex-direction: row;
  align-items: flex-end;
  gap: 12px;
}

.now-playing__panels--corner .now-playing__panel {
  flex-direction: row;
  align-items: flex-end;
  gap: 16px;
  text-align: left;
  /* A glassy panel behind the mini cover and track text, so both stay
   * readable where they sit directly on the artist background. Same recipe
   * as the lyrics panel (rgba + backdrop blur + radius). */
  background: rgba(18, 20, 28, 0.5);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  border-radius: 18px;
  padding: 16px 20px;
}

.now-playing__panels--corner.now-playing__panels--compact .now-playing__panel {
  gap: 12px;
}

/* The "next" marker between the two panels: two chevrons nudging right in a
 * loop, so the second card reads as what follows the first. No glass of its
 * own - the panel modifier has to outrank the corner panel's own glass rule
 * above. The colour comes inline from the visualizer's own (see the
 * template), so the marker and the bars read as one. */
.now-playing__panels--corner .now-playing__panel--chevrons {
  gap: 0;
  /* A fixed marker between the two cards, never grown or shrunk by them. */
  flex: none;
  /* Same soft shadow the track text carries, so the marker stays legible
   * where it sits directly on the artist background. */
  filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.7));
  padding: 0;
  background: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border-radius: 0;
  align-self: center;
}

.now-playing__next-up-chevron {
  animation: next-up-chevron 1.4s ease-in-out infinite;
}

.now-playing__next-up-chevron--second {
  animation-delay: 0.2s;
}

@keyframes next-up-chevron {
  0%,
  100% {
    opacity: 0.35;
    transform: translateX(-3px);
  }
  50% {
    opacity: 1;
    transform: translateX(0);
  }
}

/* The next panel appears to the right near the end of a track; on the change
 * the old current fades out while the next moves left into its place. The
 * move is the FLIP a transition-group gives the keyed panel whose position
 * changed; the leaving panel is taken out of the flow (its width locked by
 * lockLeaveWidth) so the next can actually move into the gap it leaves. */
.next-up-enter-active,
.next-up-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}

.next-up-move {
  transition: transform 0.5s ease;
}

.next-up-enter-from,
.next-up-leave-to {
  opacity: 0;
  transform: translateX(24px);
}

.next-up-leave-active {
  position: absolute;
}

/* The panel is the flex row now, so it (and the group it sits in) is what
 * has to be allowed to shrink for a long label to ellipsise inside it. */
.now-playing__panels--corner.now-playing__panels--compact {
  min-width: 0;
  max-width: 100%;
}

.now-playing__panels--corner.now-playing__panels--compact .now-playing__panel {
  min-width: 0;
  max-width: 100%;
}

/* On a phone the corner is a tight row: each label is one ellipsised line
 * (no wrapping - a wrapped line would push the block taller than the cover,
 * and long text would run off the screen), and the type is a step down so
 * the whole block stays small. */
.now-playing__panels--corner.now-playing__panels--compact .now-playing__info {
  min-width: 0;
}

.now-playing__panels--corner.now-playing__panels--compact .now-playing__info > * {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The title is a multi-line clamp by default (see its own rule); in the
 * corner it is a single ellipsised line like the rest. */
.now-playing__panels--corner.now-playing__panels--compact .now-playing__title {
  display: block;
  font-size: clamp(1rem, min(2.1cqw, 7cqh), 1.6rem);
}

.now-playing__panels--corner.now-playing__panels--compact .now-playing__info .eyebrow-label {
  font-size: clamp(0.55rem, min(1.4cqw, 1.8cqh), 0.75rem);
}

.now-playing__panels--corner.now-playing__panels--compact
  .now-playing__info
  .now-playing__artist-link,
.now-playing__panels--corner.now-playing__panels--compact
  .now-playing__info
  .now-playing__artist-label {
  font-size: clamp(0.68rem, min(2cqw, 2.8cqh), 1.05rem);
}

.now-playing__panels--corner.now-playing__panels--compact
  .now-playing__info
  .now-playing__album-link {
  font-size: clamp(0.58rem, min(1.5cqw, 2cqh), 0.85rem);
}

/* The mini cover carries no shadow: the glass panel behind it already
 * separates it from the artist background, and a shadow there would spill
 * out of the panel (and get clipped by the stage). */
.now-playing__panels--corner.now-playing__panels--compact .now-playing__mini-art {
  box-shadow: none;
}

/* The small cover the hidden-artwork corner shows beside the text - see the
 * template. Rounded like the artwork on the cover cards. */
.now-playing__mini-art {
  flex-shrink: 0;
  border-radius: 8px;
}

.now-playing__info {
  /* Capped to the artwork's own width (see the parent's artSize) so a long
   * unbroken title/artist has something concrete to wrap against instead of
   * growing the row past .now-playing__content's max-width. */
  max-width: min(clamp(180px, min(70cqh, 50cqw), 900px), 58cqw);
  /* A soft dark shadow under the track text, so it stays readable when the
   * artwork is hidden and it sits directly on the artist background. A
   * drop-shadow on this block, not a text-shadow on each line: the title
   * and the artist/album links clip their own overflow (line-clamp and
   * ellipsis), which cuts a text-shadow off flat at their left and right
   * edges. This block does not clip, so the shadow follows the glyphs. */
  filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.7));
}

/* Scoped to .now-playing__info, not the bare global class — .eyebrow-label
 * is used all over the app (DetailHeader.vue, HomeView.vue's hero, ...)
 * with its own fixed size; this only overrides it here, and only for
 * responsive sizing (letter-spacing/weight/color stay whatever the global
 * class already sets). */
.now-playing__info .eyebrow-label {
  font-size: clamp(0.65rem, min(1.6cqw, 2cqh), 0.85rem);
}

/* cqw/cqh (see the parent's artSize) — a fixed 2.5rem used to look
 * proportionally huge next to a small, correctly-shrunk container and
 * proportionally tiny on a large one, since it never scaled with the same
 * container the artwork already does. min() against both a width and a
 * height fraction so a *short* container shrinks text just as much as a
 * *narrow* one does. */
.now-playing__title {
  font-size: clamp(1.1rem, min(2.3cqw, 9cqh), 2.75rem);
  line-height: 1.15;
  overflow-wrap: break-word;
  /* Cut off after three lines rather than growing without limit. This line
   * is not always a song title: a radio station's ICY tag lands here too,
   * and some stations send their playout system's whole record in it (see
   * connect/core/icy_metadata.py's clean_stream_title — what survives that
   * can still be long). Nothing is lost: the station's full tag is one line
   * down in the title log.
   *
   * Both spellings: the unprefixed property is the standard one, the
   * -webkit- pair is what actually does the work in Chromium today, and
   * -webkit-box display is required for either to apply at all. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  line-clamp: 3;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

/* .now-playing__info .now-playing__artist-link (compound), not the class
 * alone. Under Vuetify 3 this was load-bearing: .text-title-large was a
 * single class at the same specificity, so without a compound selector to
 * outrank it, whichever of the two landed later in the built stylesheet
 * won. Vuetify 4 puts its utilities in a cascade layer, and this scoped
 * rule is unlayered, so it now wins on that alone regardless of
 * specificity — the compound selector is belt-and-braces rather than
 * required. Kept because it costs nothing. */
.now-playing__info .now-playing__artist-link,
/* The same line where it is not a link (see the template's compact
 * branch) - only the sizing matters, and it has to be the identical
 * number: the parent's artSize measures this block's height. */
.now-playing__info .now-playing__artist-label {
  font-size: clamp(0.9rem, min(3.4cqw, 4.5cqh), 1.5rem);
  /* Block, not the anchor's default inline — inline elements ignore
   * vertical margin and this also keeps the centered text-align behaving
   * exactly like the plain <div> this replaced. */
  display: block;
  text-decoration: none;
  overflow-wrap: break-word;
}

.now-playing__info .now-playing__album-link {
  font-size: clamp(0.75rem, min(2.5cqw, 3.4cqh), 1rem);
  text-decoration: none;
  overflow-wrap: break-word;
}

/* Radio's own equivalent of the artist link above (a station has no
 * artist/album) — same sizing, just never a link. */
.now-playing__radio-tag {
  font-size: clamp(0.9rem, min(3.4cqw, 4.5cqh), 1.5rem);
  overflow-wrap: break-word;
}

.now-playing__artist-link:hover,
.now-playing__album-link:hover {
  color: rgb(var(--v-theme-primary));
}

/* Title/artist/album otherwise inherit the desktop clamp()s above verbatim
 * — reasonable there, but on the compact container's much narrower/shorter
 * cqw/cqh this landed with artist/album reading oversized next to a title
 * that, by comparison, could afford to be a touch bigger itself. */
.now-playing__panels--compact .now-playing__info {
  max-width: 88cqw;
}

.now-playing__panels--compact .now-playing__title {
  font-size: clamp(1.2rem, min(2.4cqw, 9cqh), 2.75rem);
  /* Two, not three: the phone shell has the artwork and the controls in
   * the same column, so a third line costs proportionally far more here. */
  line-clamp: 2;
  -webkit-line-clamp: 2;
}

.now-playing__panels--compact .now-playing__info .now-playing__artist-link,
.now-playing__panels--compact .now-playing__info .now-playing__artist-label {
  font-size: clamp(0.8rem, min(2.4cqw, 3.2cqh), 1.5rem);
}

.now-playing__panels--compact .now-playing__radio-tag {
  font-size: clamp(0.8rem, min(2.4cqw, 3.2cqh), 1.5rem);
}

.now-playing__panels--compact .now-playing__info .now-playing__album-link {
  font-size: clamp(0.68rem, min(1.8cqw, 2.4cqh), 1rem);
}

/* The eyebrow, the title and the artist line, evenly spaced. The parent's
 * artSize counts on this block's height, so the gaps live here as one rule
 * rather than as a margin on each line. */
.now-playing__info > * {
  margin-bottom: 8px;
}

/* Tighter in the corner: the compact fonts are roughly half the desktop's,
 * so the same 8px reads as twice the gap. Scoped to the artwork-hidden
 * corner, where artSize (which counts on the 8px above) is not in play. No
 * gap after the last line, so the block (and the cover sized to it) hugs
 * its content. */
.now-playing__panels--corner.now-playing__panels--compact .now-playing__info > * {
  margin-bottom: 4px;
}

.now-playing__panels--corner.now-playing__panels--compact .now-playing__info > *:last-child {
  margin-bottom: 0;
}

/* The desktop corner's labels are one ellipsised line each, like the
 * phone's — a wrapped line would grow the block, and with it the mini cover
 * measured from its height. */
.now-playing__panels--corner:not(.now-playing__panels--compact) .now-playing__info > * {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The title drops its three-line clamp for that single line (see its own
 * rule), and the album link has to be a real block for the ellipsis to
 * apply at all — text-overflow does nothing on an inline box. */
.now-playing__panels--corner:not(.now-playing__panels--compact) .now-playing__title {
  display: block;
}

.now-playing__panels--corner:not(.now-playing__panels--compact) .now-playing__album-link {
  display: block;
}

/* Allowed to shrink so the next-up panel has something to bite into instead
 * of overflowing the row. */
.now-playing__panels--corner:not(.now-playing__panels--compact) {
  min-width: 0;
  max-width: 100%;
}

/* A card is as wide as its own text wants, not a forced equal share: while
 * the row has room the two cards keep their natural, possibly different
 * widths. Only when it runs out do they give, and it is the wider card that
 * gives first - a flex-basis of 0 grows both into the free space equally,
 * but max-content caps that growth at what each card actually needs, so the
 * narrower one stops growing (and later stops shrinking) at its own width
 * while the wider one takes the rest. min-width: 0 lets a card and its
 * labels shrink below their content and ellipsise. */
.now-playing__panels--corner:not(.now-playing__panels--compact) .now-playing__panel {
  flex: 1 1 0;
  min-width: 0;
  max-width: max-content;
}

.now-playing__panels--corner:not(.now-playing__panels--compact) .now-playing__info {
  min-width: 0;
}
</style>
