<template>
  <div class="now-playing fill-height d-flex align-center justify-center">
    <div class="now-playing__backdrop" :style="backdropStyle" />
    <div class="now-playing__scrim" :style="ambientStyle" />

    <div v-if="hasPlayable" class="now-playing__toolbar">
      <v-btn
        :icon="showVisualizer ? 'mdi-equalizer' : 'mdi-equalizer-outline'"
        variant="text"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="showVisualizer = !showVisualizer"
      />
      <v-btn
        v-if="currentTrack"
        :icon="showLyrics ? 'mdi-image-outline' : 'mdi-script-text-outline'"
        variant="text"
        :title="$t('lyrics.title')"
        @click="showLyrics = !showLyrics"
      />
    </div>

    <div
      v-if="hasPlayable"
      class="now-playing__content"
      :class="{ 'now-playing__content--split': showLyrics }"
    >
      <div class="now-playing__primary">
        <div class="now-playing__art-wrap">
          <div class="now-playing__art-glow" :style="{ background: glowColor }" />
          <cover-art
            v-if="currentTrack"
            :cover-art-id="currentTrack.coverArtId"
            :size="showLyrics ? 320 : 540"
            class="cover-shadow"
          />
          <v-icon v-else icon="mdi-radio" size="260" class="now-playing__radio-icon" />
        </div>

        <div class="now-playing__info">
          <div class="eyebrow-label mb-2">{{ eyebrow }}</div>
          <h1 class="detail-title now-playing__title mb-2">
            {{ currentTrack?.title ?? playbackStore.radioStation?.name }}
          </h1>
          <router-link
            v-if="currentTrack"
            :to="`/artists/${currentTrack.artistId}`"
            class="text-h6 text-medium-emphasis now-playing__artist-link mb-2"
          >
            {{ currentTrack.artist }}
          </router-link>
          <div v-else class="text-h6 text-medium-emphasis mb-2" />
          <router-link
            v-if="currentTrack"
            :to="`/albums/${currentTrack.albumId}`"
            class="text-body-2 text-medium-emphasis now-playing__album-link"
          >
            {{ currentTrack.album }}
          </router-link>
        </div>
      </div>

      <transition name="now-playing-lyrics">
        <lyrics-panel v-if="showLyrics" variant="immersive" class="now-playing__lyrics" />
      </transition>
    </div>

    <div v-else class="now-playing__content">
      <span class="text-medium-emphasis">{{ $t('nowPlaying.nothingPlaying') }}</span>
    </div>

    <!-- Real audio-reactive either way: a local Web Audio analyser during
     - local playback, or the backend's own real-time analysis (see
     - connect/core/audio_analysis.py) while casting to a target it can
     - actually run against — see visualizerAvailable for which can't.
     - Stays mounted a moment past visualizerActive going false so the
     - `active` prop below can let it settle to 0 first instead of just
     - vanishing — see the visualizerActive watcher. -->
    <div v-if="visualizerMounted" class="now-playing__visualizer">
      <audio-visualizer :active="visualizerActive" />
    </div>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useLyricsStore } from '@/stores/lyrics'
import { useConnectStore } from '@/stores/connect'
import CoverArt from '@/components/library/CoverArt.vue'
import LyricsPanel from '@/components/lyrics/LyricsPanel.vue'
import AudioVisualizer from '@/components/player/AudioVisualizer.vue'
import { extractDominantColor } from '@/services/colorExtractor'

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed).
const FALLBACK_COLOR = '245, 169, 78'

// Persisted across restarts — a one-off UI preference, not session state,
// same "single localStorage key" convention as stores/lyrics.ts's offsets.
const SHOW_VISUALIZER_KEY = 'beacon.showVisualizer'

function readShowVisualizer(): boolean {
  try {
    // Absent (never toggled before) defaults to shown.
    return localStorage.getItem(SHOW_VISUALIZER_KEY) !== 'false'
  } catch {
    return true
  }
}

// How long <audio-visualizer> stays mounted (with active=false) after
// visualizerActive goes false — long enough for its own smoothing to
// visibly settle every bar to 0 before it's actually removed.
const VISUALIZER_HIDE_DELAY_MS = 400

export default {
  name: 'NowPlayingView',
  components: { CoverArt, LyricsPanel, AudioVisualizer },
  data() {
    return {
      // "r, g, b" — kept as a CSS-ready string so the two computed styles
      // below don't each redo the same join().
      extractedColor: null as string | null,
      showVisualizer: readShowVisualizer(),
      showLyrics: false,
      // Whether <audio-visualizer> is actually in the DOM — trails
      // visualizerActive by visualizerHideDelayMs on the way down so its
      // fall-to-0 animation (see its `active` prop) has time to play
      // before it's removed; see the visualizerActive watcher below.
      visualizerMounted: false,
      visualizerHideTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    connectStore() {
      return useConnectStore()
    },
    currentTrack() {
      return this.playbackStore.currentTrack
    },
    hasPlayable() {
      return this.currentTrack != null || this.playbackStore.radioStation != null
    },
    // AirPlay downloads a whole track into memory *ahead* of pushing it to
    // the device (see connect/delivery/airplay.py), and radio's raw
    // station URL bypasses connect's streaming pipeline entirely — neither
    // has real audio data for the backend to analyze (see
    // connect/core/audio_analysis.py's should_analyze()), so there's
    // nothing honest to show for them rather than a fake animation.
    visualizerAvailable() {
      if (!this.playbackStore.isCasting) return true
      if (!this.currentTrack) return false // casting radio
      return this.connectStore.activeTargets.some((target) => target.type !== 'airplay')
    },
    visualizerActive() {
      return this.hasPlayable && this.showVisualizer && this.visualizerAvailable
    },
    eyebrow() {
      if (this.currentTrack)
        return this.playbackStore.isPlaying ? this.$t('home.nowPlaying') : this.$t('home.paused')
      if (this.playbackStore.radioStation) return this.$t('home.radioEyebrow')
      return ''
    },
    coverArtUrl(): string | null {
      const id = this.currentTrack?.coverArtId
      return id ? useLibraryStore().client().coverArtUrl(id, 400) : null
    },
    // Full-bleed blurred artwork behind everything — same backdrop language
    // as DetailHeader.vue's hero cards (blur + scrim over the item's own
    // art). Empty for radio (no artwork), which just falls back to the
    // plain ambient wash below.
    backdropStyle() {
      return this.coverArtUrl ? { backgroundImage: `url(${this.coverArtUrl})` } : {}
    },
    colorTriplet(): string {
      return this.extractedColor ?? FALLBACK_COLOR
    },
    // A soft, wide wash filling the whole screen — the "room" the artwork
    // sits in reacts to whatever's playing, the same idea as the lighthouse
    // in the app's own name: the light changes color with what it's
    // guiding you through. Sits *over* the backdrop above as a semi-
    // transparent tint (matching DetailHeader's own 0.55 scrim opacity),
    // not an opaque fill — the blurred artwork needs to still show through.
    ambientStyle() {
      return {
        background: `radial-gradient(ellipse 65% 55% at 50% 32%, rgba(${this.colorTriplet}, 0.35), rgba(18, 20, 28, 0) 70%), rgba(18, 20, 28, 0.55)`,
      }
    },
    // A tighter, brighter halo immediately behind the artwork — a light
    // source rather than a room tint, layered on top of ambientStyle.
    glowColor() {
      return `radial-gradient(circle, rgba(${this.colorTriplet}, 0.55) 0%, rgba(${this.colorTriplet}, 0) 70%)`
    },
  },
  watch: {
    coverArtUrl: {
      immediate: true,
      handler(url: string | null) {
        this.extractedColor = null
        if (url) this.loadColor(url)
      },
    },
    // Loads on entering lyrics mode, and again on every track change while
    // already in it — see LyricsDrawer.vue's identical pair of watchers for
    // why this is consumer-triggered rather than eager in the store itself.
    showLyrics(show: boolean) {
      if (show && this.currentTrack) useLyricsStore().ensureLoaded(this.currentTrack)
    },
    currentTrack(track) {
      // Radio has no lyrics concept — fall back to the normal artwork view
      // instead of being stuck showing lyrics for nothing.
      if (!track) {
        this.showLyrics = false
        return
      }
      if (this.showLyrics) useLyricsStore().ensureLoaded(track)
    },
    showVisualizer(value: boolean) {
      try {
        localStorage.setItem(SHOW_VISUALIZER_KEY, String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
    // Mount instantly on the way up; on the way down, keep it mounted
    // (with active=false) for VISUALIZER_HIDE_DELAY_MS so AudioVisualizer's
    // own smoothing can settle every bar to 0 first — see its `active`
    // prop. Without this the whole element (and whatever it was mid-way
    // through animating) would just vanish instantly instead.
    visualizerActive: {
      immediate: true,
      handler(active: boolean) {
        if (this.visualizerHideTimer) {
          clearTimeout(this.visualizerHideTimer)
          this.visualizerHideTimer = null
        }
        if (active) {
          this.visualizerMounted = true
        } else if (this.visualizerMounted) {
          this.visualizerHideTimer = setTimeout(() => {
            this.visualizerMounted = false
          }, VISUALIZER_HIDE_DELAY_MS)
        }
      },
    },
  },
  beforeUnmount() {
    if (this.visualizerHideTimer) clearTimeout(this.visualizerHideTimer)
  },
  methods: {
    async loadColor(url: string) {
      const color = await extractDominantColor(url)
      // The track may have changed again while the image was loading —
      // don't let a stale extraction overwrite whatever's current now.
      if (url !== this.coverArtUrl) return
      this.extractedColor = color ? color.join(', ') : null
    },
  },
}
</script>

<style scoped>
.now-playing {
  width: 100%;
  position: relative;
  overflow: hidden;
  /* Opaque fallback behind the two layers below — matters for radio, where
   * .now-playing__backdrop has no image to show. */
  background: #12141c;
}

/* Full-bleed blurred artwork — same technique as DetailHeader.vue's
 * .detail-header__backdrop (blur + oversized + scaled so the blur radius
 * never reveals a hard edge at the viewport bounds). */
.now-playing__backdrop {
  position: absolute;
  inset: -60px;
  background-size: cover;
  background-position: center;
  filter: blur(50px) saturate(1.3) brightness(0.5);
  transform: scale(1.15);
  transition: background-image 0.6s ease;
}

.now-playing__scrim {
  position: absolute;
  inset: 0;
  /* Ambient color is set inline (:style) since it depends on the track;
   * the transition is what makes it change *into* the new color smoothly
   * on a track change instead of snapping. */
  transition: background 1.2s ease;
}

/* Always a row (even with just one child, .now-playing__primary, when
 * lyrics are hidden) so toggling lyrics never flips flex-direction itself
 * — that can't be transitioned. Instead .now-playing__lyrics animates its
 * own width from 0 up, and since this row stays centered throughout, the
 * artwork column drifts left on its own as the row grows to fit both. */
.now-playing__content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px;
  max-width: 640px;
  gap: 0;
  transition:
    gap 0.45s ease,
    max-width 0.45s ease;
}

.now-playing__content--split {
  max-width: 1100px;
  width: 90%;
  gap: 56px;
}

.now-playing__primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  flex-shrink: 0;
}

/* Tall, bounded reading area — LyricsPanel scrolls within whatever height
 * it's given. A fixed target width (not flex: 1) so the enter/leave
 * transition below has a concrete value to animate from/to; overflow
 * hidden clips its contents while that width is mid-animation. */
.now-playing__lyrics {
  flex-shrink: 0;
  width: min(44vw, 600px);
  height: 70vh;
  overflow: hidden;
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

@media (prefers-reduced-motion: reduce) {
  .now-playing__content,
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active,
  .now-playing__art-wrap :deep(.cover-art) {
    transition: none;
  }
}

.now-playing__toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 2;
  display: flex;
  gap: 4px;
}

/* Padding lives here, not on the canvas — a canvas's own CSS padding
 * would desync from its drawing buffer (sized off getBoundingClientRect,
 * which includes padding), pushing the bars off-center from where the
 * bitmap actually paints. */
.now-playing__visualizer {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  z-index: 1;
  height: 128px;
  padding: 0 5px 0px;
  pointer-events: none;
}

.now-playing__art-wrap {
  position: relative;
  margin-bottom: 40px;
}

.now-playing__art-glow {
  position: absolute;
  inset: -70px;
  border-radius: 50%;
  filter: blur(60px);
  transition: background 1.2s ease;
  z-index: 0;
}

.now-playing__art-wrap :deep(.cover-art) {
  position: relative;
  z-index: 1;
  /* Matches the lyrics-panel width transition's timing so the artwork
   * shrinking and the lyrics column growing read as one motion. */
  transition:
    width 0.45s ease,
    height 0.45s ease;
}

.now-playing__radio-icon {
  position: relative;
  z-index: 1;
}

.now-playing__title {
  font-size: 2.5rem;
  line-height: 1.15;
}

.now-playing__artist-link {
  /* Block, not the anchor's default inline — inline elements ignore
   * vertical margin (mb-2 here would otherwise silently do nothing) and
   * this also keeps the centered text-align behaving exactly like the
   * plain <div> this replaced. */
  display: block;
  text-decoration: none;
}

.now-playing__album-link {
  text-decoration: none;
}

.now-playing__artist-link:hover,
.now-playing__album-link:hover {
  color: rgb(var(--v-theme-primary));
}
</style>
