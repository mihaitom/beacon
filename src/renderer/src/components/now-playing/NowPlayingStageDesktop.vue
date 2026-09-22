<template>
  <div class="now-playing__stage-desktop">
    <div
      class="now-playing__content"
      :class="{
        'now-playing__content--split': hasPlayable && showLyrics,
        'now-playing__content--corner': artworkHidden,
      }"
    >
      <template v-if="hasPlayable">
        <!-- display: contents outside the portrait container query (see
         - .now-playing__flip-card in <style>) — .now-playing__primary and the
         - lyrics panel behave as direct flex children of
         - .now-playing__content--split there. Only on a portrait/narrow-aspect
         - stage does it become a real, positioned box: the "card" a 3D flip
         - rotates, with the artwork+info as its front face and lyrics
         - absolutely positioned as the back one. -->
        <div class="now-playing__flip-card">
          <div class="now-playing__primary">
            <now-playing-artwork
              v-if="!artworkHidden"
              :song="currentSong"
              :radio-favicon="radioFavicon"
              :art-size="artSize"
              :glow-color="glowColor"
            />

            <!-- The track panel(s). Normally just the current song; near the
             - end of a track animated chevrons and the next one are added to
             - the right (see panels), the next glass card sliding left into
             - the current's place on the change. With the artwork hidden each
             - panel is the small cover + labels; with the artwork shown the
             - single panel is just the labels under it. -->
            <now-playing-track-panels
              :panels="panels"
              :artwork-hidden="artworkHidden"
              :visualizer-color="visualizerColor"
            />
          </div>

          <transition name="now-playing-lyrics">
            <lyrics-panel
              v-if="showLyrics && currentSong"
              variant="immersive"
              class="now-playing__lyrics"
            />
            <!-- Radio takes the same half of the split (and the same back
               - face of the portrait flip card): no lyrics to show, but the
               - station's own title log to read instead. -->
            <radio-title-log
              v-else-if="showLyrics && radioStation"
              variant="immersive"
              :entries="titleLogEntries"
              :has-more="!radioMeta.hasActiveSearch && !radioMeta.titleLogComplete"
              :query="radioMeta.searchQuery"
              :current-at="radioMeta.titleLog[0]?.at ?? null"
              :pending="radioMeta.searchPending"
              class="now-playing__lyrics now-playing__lyrics--title-log"
              @load-more="radioMeta.loadOlder()"
              @update:query="$emit('search', $event)"
            />
          </transition>
        </div>
      </template>

      <span v-else class="text-medium-emphasis">{{ $t('nowPlaying.nothingPlaying') }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import LyricsPanel from '@/components/lyrics/LyricsPanel.vue'
import RadioTitleLog from '@/components/radio/RadioTitleLog.vue'
import NowPlayingArtwork from '@/components/now-playing/NowPlayingArtwork.vue'
import NowPlayingTrackPanels from '@/components/now-playing/NowPlayingTrackPanels.vue'
import type { NowPlayingPanel } from '@/components/now-playing/types'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'
import type { Song } from '@/types/library'

/** The desktop stage: artwork and lyrics side by side on a wide window,
 * flipping the card over to show the lyrics once the stage is too narrow.
 * Separate from the phone's stage because that one is always-flip and
 * full-screen; only the presentational leaves (NowPlayingArtwork,
 * NowPlayingTrackPanels) are shared. The container keeps the data, the
 * backdrop, the toolbar, the visualizer and the flip/slide mechanics; this
 * only renders the card and reads the stores it needs to. */
export default {
  name: 'NowPlayingStageDesktop',
  components: {
    LyricsPanel,
    RadioTitleLog,
    NowPlayingArtwork,
    NowPlayingTrackPanels,
  },
  props: {
    artworkHidden: {
      type: Boolean,
      default: false,
    },
    glowColor: {
      type: String,
      required: true,
    },
    visualizerColor: {
      type: String,
      required: true,
    },
    radioFavicon: {
      type: Object as () => RadioFaviconRequest | null,
      default: null,
    },
    panels: {
      type: Array as () => NowPlayingPanel[],
      required: true,
    },
    titleLogEntries: {
      type: Array as () => RadioTitleEntry[],
      required: true,
    },
  },
  emits: ['search'],
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    drawersStore() {
      return useDrawersStore()
    },
    radioMeta() {
      return useRadioMetadataStore()
    },
    currentSong(): Song | null {
      return this.playbackStore.currentSong
    },
    radioStation() {
      return this.playbackStore.radioStation
    },
    hasPlayable(): boolean {
      return this.currentSong != null || this.radioStation != null
    },
    showLyrics(): boolean {
      return this.drawersStore.lyricsPanelOpen
    },
    /** cqh/cqw (container query units), not vh/vw — .now-playing__stage is a
     * `container-type: size` host sized by the container's own grid, after
     * the app-bar/PlayerBar outside and the visualizer row below it have
     * taken their share, so cqh/cqw measure the space actually left for the
     * artwork. min()'d against both a height and a width fraction: a *short*
     * container and a *narrow* one are both real ways to run out of room. */
    artSize(): string {
      return 'clamp(180px, min(70cqh, 50cqw), 900px)'
    },
  },
}
</script>

<style scoped>
/* display: contents so .now-playing__content below becomes the flex item of
 * the container's .now-playing__stage — this wrapper exists only to keep the
 * container's own scoped .now-playing__content rules from reaching in (a
 * child component's root inherits the parent's scope id, its descendants do
 * not). */
.now-playing__stage-desktop {
  display: contents;
}

/* Always a row (even with just one child, .now-playing__primary, when lyrics
 * are hidden) so toggling lyrics never flips flex-direction itself — that
 * can't be transitioned. Instead .now-playing__lyrics animates its own width
 * from 0 up, and since this row stays centered throughout, the artwork column
 * drifts to the side on its own as the row grows to fit both — see
 * .now-playing__content--split's much wider cap below. */
.now-playing__content {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px;
  /* .now-playing__primary is flex-shrink: 0, so on a screen where the artwork
   * reaches close to artSize's 900px ceiling, a flat 640px here undersold
   * what this box needed to comfortably contain before overflowing it. */
  max-width: 1000px;
  gap: 0;
  transition:
    gap 0.45s ease,
    max-width 0.45s ease;
}

.now-playing__content--split {
  max-width: 1800px;
  width: 96cqw;
  /* Grows with the stage's own width instead of a flat 40px, which read as
   * cramped once the artwork itself started scaling up on wide monitors. */
  gap: clamp(40px, 6cqw, 120px);
  /* Never wrap. A row that wraps puts the lyrics *under* the artwork, which
   * reads as the layout breaking rather than as a tight fit. The panel gives
   * way instead (see .now-playing__lyrics' flex-shrink), which costs reading
   * width and nothing else. */
  flex-wrap: nowrap;
}

/* Transparent to layout by default — see the portrait container query below
 * for what it becomes. */
.now-playing__flip-card {
  display: contents;
}

.now-playing__primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  flex-shrink: 0;
}

/* With the artwork hidden the track text leaves the centre for the
 * bottom-left corner, so the artist background is what the screen is about.
 * space-between, not flex-start: with the lyrics panel open it belongs on the
 * right, where it sits with the artwork shown, rather than being dragged over
 * next to the text. */
.now-playing__content--corner {
  width: 100%;
  height: 100%;
  max-width: none;
  align-items: flex-end;
  justify-content: space-between;
  /* More than the base 32px: .now-playing__stage clips (overflow: hidden)
   * and the mini cover's shadow (.cover-shadow: 12px offset + 32px blur)
   * otherwise runs off the bottom edge and is cut. */
  padding-bottom: 56px;
}

/* The lyrics get their own ground to sit on - the amber glow the active line
 * carries is not enough over a bright backdrop, and over a sharp artist photo
 * it is not enough at all. A translucent, blurred panel, the same idea as the
 * app's other scrims. */
.now-playing__lyrics {
  background: rgba(18, 20, 28, 0.62);
  backdrop-filter: blur(10px);
  border-radius: 18px;
  /* Tall, bounded reading area — LyricsPanel scrolls within whatever height
   * it's given. A fixed target width (not flex: 1) so the enter/leave
   * transition below has a concrete value to animate from/to; overflow hidden
   * clips its contents while that width is mid-animation. Shrinkable, unlike
   * .now-playing__primary: this is a column of text that scrolls, so a
   * narrower box costs reading width. min-width: 0 because a flex item does
   * not shrink below its content otherwise. */
  flex-shrink: 1;
  min-width: 0;
  width: min(38cqw, 560px);
  height: 85cqh;
  overflow: hidden;
}

/* A station's title log borrows the lyrics' box - the same width, height
 * and scrolling - but not its ground. The lyrics are lines of text drawn
 * straight on the artwork, so they need a panel under them; the log is
 * already a column of opaque cards and the timeline is mixed to read on a
 * picture (see RadioTitleLog.vue's immersive rules), so a panel behind it
 * is a slab of grey for nothing. */
.now-playing__lyrics--title-log {
  background: none;
  backdrop-filter: none;
  border-radius: 0;
}

.now-playing-lyrics-enter-active,
.now-playing-lyrics-leave-active {
  transition:
    width 0.45s ease,
    opacity 0.35s ease;
}

.now-playing-lyrics-enter-from,
.now-playing-lyrics-leave-to {
  width: 0;
  opacity: 0;
}

/* Not enough width for artwork and lyrics to sit side by side. Past this
 * point, flip the artwork+info card over like turning it to its back instead
 * — lyrics take over the exact box the artwork just occupied, rather than
 * fighting it for space.
 *
 * Two conditions, because "does it still fit" genuinely depends on both the
 * container's shape *and* its width — the artwork is min(70cqh, 50cqw), so a
 * tall container sizes it off the width and a flat one off the height, and
 * those two regimes run out of room at completely different places:
 *
 *  - max-aspect-ratio: 4/5 — portrait.
 *  - max-width: 1560px and not flatter than 3/2 — where the artwork is
 *    width-driven, side by side only actually fits from ~1560px up: artwork
 *    (50cqw) + gap (6cqw) + lyrics (38cqw) is 94% of a row that only ever
 *    gets 96cqw minus 64px of padding, so the three grow almost exactly as
 *    fast as the room for them. Measured, not derived on paper — see
 *    NowPlayingView.layout.browser.test.ts, which pins both sides of this
 *    boundary. A flatter container (a short, wide window) caps the artwork at
 *    70cqh well before that and keeps fitting comfortably, which is what the
 *    aspect-ratio half of the condition preserves.
 *
 * Standard CSS "flip card" construction: .now-playing__flip-card is the
 * rotating element, .now-playing__primary (front) sizes it via normal flow,
 * .now-playing__lyrics (back) is absolutely positioned to exactly cover that
 * same box, and both faces hide their own backface so only whichever one is
 * currently "facing forward" after the rotation is actually visible. */
@container now-playing-stage (
  (max-aspect-ratio: 4/5) or ((max-width: 1560px) and (max-aspect-ratio: 3/2))
) {
  .now-playing__content--split {
    /* A single card now, sized by its own content — no max-width of its own
     * on purpose: max-width is transitioned (see .now-playing__content), and
     * a container query ceasing to match animates it like any other change.
     * Narrowing it here left the row growing back to 1800px for 0.45s while
     * both panels were already in flow needing more than that, so they
     * wrapped into two rows on the way out. */
    width: auto;
    gap: 0;
    perspective: 2000px;
  }

  /* As tall as the stage, not as tall as its own contents: only the artwork
   * is sized by artSize(), and the back face (lyrics, or a station's title
   * log) is sized to this box. A 1200x1000 window left 292px of it unused. */
  .now-playing__content {
    height: 100%;
  }

  .now-playing__flip-card {
    display: block;
    position: relative;
    height: 100%;
    transform-style: preserve-3d;
    transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
    /* NOT container-type: size on this element itself — it has no explicit
     * width, only ever getting one from .now-playing__primary's own content
     * via normal flow, which is exactly what size containment can't coexist
     * with: a container query container's own size has to come from something
     * other than its content, or the browser collapses that axis to ~0. That
     * happened here: card width collapsed to near nothing, and every
     * cqw-based measurement inside it inherited that collapse. See
     * .now-playing__lyrics below for where the containment actually
     * belongs. */
  }

  .now-playing__content--split .now-playing__flip-card {
    transform: rotateY(180deg);
  }

  .now-playing__primary {
    /* Fills the taller card, with its own contents still centred in it, so
     * the artwork and the title under it stay where they were. */
    height: 100%;
    justify-content: center;
    /* An explicit identity rotation, not just the absence of one — Chromium
     * only reliably factors an ancestor's preserve-3d rotation into *this*
     * element's own backface-visibility check once it has a 3D transform of
     * its own to compose with that ancestor's transform in the same 3D
     * space. Without it, the artwork face stayed visibly rendered through the
     * "back" of the card instead of hiding. */
    transform: rotateY(0deg);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  .now-playing__lyrics {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    transform: rotateY(180deg);
    /* Unlike the card itself (see its own comment), this is safe: width/height
     * are already explicit (100% of .now-playing__flip-card, a *positioned*
     * ancestor with a real, content-derived size of its own) *before*
     * containment is applied, so there's nothing for it to collapse.
     * Re-anchors every cqw/cqh unit inside this element (including
     * LyricsPanel.vue's own) to the same box the artwork actually occupies,
     * instead of the outer .now-playing__stage. */
    container-type: size;
    /* Consumed by LyricsPanel.vue's own .lyrics-panel--immersive
     * .lyrics-panel__line rule — a custom property, not a value overridden
     * from out here via a selector, since this element's font-size/padding
     * live inside a separate scoped component. Tuned against *this* box
     * (matching the artwork, not the full stage). */
    --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
    --lyrics-flip-line-padding: 10px 20px;
  }

  /* No width animation here — the flip itself carries that. But this can't
   * drop to `transition: none` outright: Vue's <transition> figures out how
   * long to keep a leaving element in the DOM by listening for *this*
   * element's own transitionend, and the flip's actual rotation lives on
   * .now-playing__flip-card (an ancestor), not here — with nothing to listen
   * for, Vue removed the lyrics panel almost immediately instead of waiting
   * out the flip. Matching the flip's own 0.7s duration with an opacity fade
   * keeps a real transition on the element Vue is actually watching. */
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active {
    transition: opacity 0.7s ease;
    width: 100%;
  }

  .now-playing-lyrics-enter-from,
  .now-playing-lyrics-leave-to {
    /* width explicit here too — this and -active both apply to the element at
     * once during the transition, and leaving it implicit invited relying on
     * specificity order to resolve the conflict with the base (non-flip)
     * -enter-from/-leave-to rule's own `width: 0`. */
    width: 100%;
    opacity: 0;
  }
}

/* With the artwork hidden there is nothing for the flip card to turn to - the
 * flip exists to give the lyrics the artwork's own box, and there is no
 * artwork - so the lyrics simply show beside the text, as in the wide
 * layout, however narrow the stage is. */
.now-playing__content--corner .now-playing__flip-card {
  display: contents;
  transform: none;
  transition: none;
}

.now-playing__content--split.now-playing__content--corner {
  width: 100%;
  max-width: none;
  gap: clamp(24px, 4cqw, 80px);
  perspective: none;
}

.now-playing__content--corner .now-playing__primary {
  height: auto;
  justify-content: normal;
  transform: none;
  backface-visibility: visible;
  -webkit-backface-visibility: visible;
  /* No width cap of its own: the lyrics beside it are fixed (see below), so
   * this column shrinks to whatever is left for it however wide the two
   * cards want to be - they share that width equally among themselves (see
   * NowPlayingTrackPanels' corner rule). Shrinkable with min-width: 0 so the
   * labels ellipsise rather than pushing the lyrics out. */
  min-width: 0;
  flex-shrink: 1;
}

.now-playing__content--corner .now-playing__lyrics {
  position: static;
  inset: auto;
  /* Fixed, unlike the wide side-by-side layout above: here the corner panels
   * absorb the give (they shrink and ellipsise), so the reading panel keeps
   * its full width instead of losing it to a long track title. */
  flex: none;
  width: min(38cqw, 560px);
  height: 85cqh;
  transform: none;
  backface-visibility: visible;
  -webkit-backface-visibility: visible;
}

@media (prefers-reduced-motion: reduce) {
  .now-playing__content,
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active,
  .now-playing__flip-card {
    transition: none;
  }
}
</style>
