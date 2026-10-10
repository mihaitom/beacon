<template>
  <div class="now-playing__stage-mobile">
    <div
      class="now-playing__content"
      :class="{
        'now-playing__content--split': hasPlayable && source.ui.lyricsOpen,
        'now-playing__content--corner': source.ui.artworkHidden,
        'now-playing__content--landscape': landscape,
      }"
    >
      <template v-if="hasPlayable">
        <div class="now-playing__flip-card">
          <div class="now-playing__primary">
            <now-playing-artwork v-if="!source.ui.artworkHidden" :art-size="artSize" compact />
            <!-- Sideways, the track text is in the presentation's right
             - column, so turning the card to the lyrics leaves it readable. -->
            <now-playing-track-panels v-if="!landscape" compact />
          </div>

          <transition name="now-playing-lyrics">
            <lyrics-panel
              v-if="source.ui.lyricsOpen && source.song"
              variant="immersive"
              mobile
              class="now-playing__lyrics"
            />
            <!-- Radio takes the same back face of the flip card: no lyrics to
               - show, but the station's own title log to read instead. -->
            <component
              :is="source.titleLogComponent"
              v-else-if="source.ui.lyricsOpen && source.radio && source.capabilities.titleLog"
              variant="immersive"
              :entries="source.radio.titleLog"
              :has-more="!source.radio.hasActiveSearch && !source.radio.titleLogComplete"
              :query="source.radio.searchQuery"
              :current-at="source.radio.titleLog[0]?.at ?? null"
              :pending="source.radio.searchPending"
              class="now-playing__lyrics now-playing__lyrics--title-log"
              @load-more="source.loadOlderTitles()"
              @update:query="source.searchTitles($event)"
            />
          </transition>
        </div>
      </template>

      <span v-else class="text-medium-emphasis">{{ $t('nowPlaying.nothingPlaying') }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import LyricsPanel from '@/components/lyrics/LyricsPanel.vue'
import NowPlayingArtwork from '@/components/now-playing/NowPlayingArtwork.vue'
import NowPlayingTrackPanels from '@/components/now-playing/NowPlayingTrackPanels.vue'
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'

/** The phone's stage: the same artwork/track/lyrics content as the desktop
 * one, laid out as an always-flipping card that fills the whole screen. It
 * is a separate component from the desktop stage because the phone's layout
 * and sizing share almost nothing with the side-by-side one — only the
 * presentational leaves (NowPlayingArtwork, NowPlayingTrackPanels) are
 * common. The source keeps the data, the backdrop, the toolbar, the
 * visualizer and the flip/slide mechanics; this only renders the card. */
export default {
  name: 'NowPlayingStageMobile',
  components: {
    LyricsPanel,
    NowPlayingArtwork,
    NowPlayingTrackPanels,
  },
  mixins: [nowPlayingSourceMixin],
  props: {
    /** The phone on its side: this stage is the left column and holds the
     * artwork alone. */
    landscape: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    hasPlayable(): boolean {
      return this.source.song != null || this.source.radio != null
    },
    /** The compact fractions come from measuring what the stage actually
     * leaves (see NowPlayingView.compact.layout.browser.test.ts): once
     * .now-playing__content's 16px side padding is off, the width available
     * is ~91cqw, so the height fraction has to leave room for the info block
     * and padding under the artwork. 90cqw rather than the ~98 the box would
     * tolerate: the last few percent are margin, not waste. */
    artSize(): string {
      // Sideways there is nothing under the artwork: the whole column, less
      // .now-playing__content's padding.
      if (this.landscape) return 'clamp(88px, min(calc(100cqh - 24px), calc(100cqw - 32px)), 480px)'
      return 'clamp(88px, min(58cqh, 90cqw, calc(100cqh - 100px)), 480px)'
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
.now-playing__stage-mobile {
  display: contents;
}

/* Compact (mobile) always flips, regardless of what .now-playing__stage's
 * own measured aspect ratio comes out to. Unlike a desktop window, which
 * can genuinely be any shape, compact's "stage" height is already squeezed
 * by MobileTransportControls.vue/the tab bar below it — once that, the
 * toolbar, and the title/artist/album text are subtracted from a phone's
 * available height, the remaining box can measure out right at (or just
 * past) the max-aspect-ratio: 4/5 cutoff, so relying on a container query
 * here flapped between flip and the side-by-side fallback depending on
 * device size and how long the current song's text happened to be. There is
 * no side-by-side alternative on mobile ever — flip is simply always the
 * answer here. */
.now-playing__content {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  /* The full width and height of the stage: the card (and the lyrics panel
   * covering it) spans the screen, and the artwork-hidden corner sits at the
   * screen's own bottom, centred. */
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  max-width: 100%;
  gap: 0;
  transition:
    gap 0.45s ease,
    max-width 0.45s ease;
}

.now-playing__content--split {
  /* No width of its own: it keeps the full-width .now-playing__content
   * above, unlike the desktop flip whose card stays sized to the artwork. A
   * phone has no room to spend on the artwork's own narrow box, so the
   * lyrics get the whole screen. */
  gap: 0;
  perspective: 2000px;
}

.now-playing__flip-card {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}

.now-playing__content--split .now-playing__flip-card {
  transform: rotateY(180deg);
}

.now-playing__primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  height: 100%;
  flex-shrink: 0;
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

/* Nothing below the artwork to keep a gap to. */
.now-playing__content--landscape .now-playing__art-wrap {
  margin-bottom: 0;
}

/* In the artwork-hidden corner the card shrinks to its contents, or the
 * glass panel would cover the whole screen instead of wrapping the cover
 * and text. Bottom-aligned and centred: the panel sits along the bottom edge
 * with the artwork and labels in the middle of the screen. Shrinkable and
 * capped to the stage: a long label must ellipsise inside the panel, not run
 * off the right of the screen (the cover keeps its size via its own
 * flex-shrink: 0). */
.now-playing__content--corner .now-playing__flip-card {
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.now-playing__content--corner .now-playing__primary {
  height: auto;
  width: auto;
  max-width: 100%;
  min-width: 0;
  flex-shrink: 1;
}

/* The back face fills the whole phone screen. The panel would otherwise be
 * a flat slab of the base 0.62, which would bury the artist background the
 * view exists to show: dark enough in the middle - where the active line
 * sits - to stay readable, fading out top and bottom so the photo shows
 * through. No radius: a full-bleed panel has no corner to round. */
.now-playing__lyrics {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  transform: rotateY(180deg);
  /* See the desktop stage's matching rule for why containment belongs here
   * and not on .now-playing__flip-card itself, and for what the custom
   * properties below are for. */
  container-type: size;
  --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
  --lyrics-flip-line-padding: 10px 20px;
  background: linear-gradient(
    to bottom,
    rgba(18, 20, 28, 0.15) 0%,
    rgba(18, 20, 28, 0.6) 26%,
    rgba(18, 20, 28, 0.6) 74%,
    rgba(18, 20, 28, 0.15) 100%
  );
  border-radius: 0;
}

/* The log takes the lyrics' full-screen box but none of their ground: its
 * entries are opaque cards and its timeline is built to read on the
 * artwork (see RadioTitleLog.vue's immersive rules), so the fading wash
 * that keeps lyric lines legible would only dim the photo behind them. */
.now-playing__lyrics--title-log {
  background: none;
}

/* No width animation here — the flip itself carries that. But this can't
 * drop to `transition: none` outright: Vue's <transition> figures out how
 * long to keep a leaving element in the DOM by listening for *this*
 * element's own transitionend, and the flip's actual rotation lives on
 * .now-playing__flip-card (an ancestor), not here — with nothing to listen
 * for, Vue removed the lyrics panel from the DOM almost immediately instead
 * of waiting out the flip. Matching the flip's own 0.7s duration with an
 * opacity fade keeps a real transition on the element Vue is actually
 * watching. */
.now-playing-lyrics-enter-active,
.now-playing-lyrics-leave-active {
  transition: opacity 0.7s ease;
  width: 100%;
}

.now-playing-lyrics-enter-from,
.now-playing-lyrics-leave-to {
  width: 100%;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .now-playing__content,
  .now-playing__flip-card {
    transition: none;
  }
}
</style>
