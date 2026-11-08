<template>
  <div v-if="available" class="stats-visualizer" :style="{ '--bar': color }">
    <visualizer-bars
      v-if="showBars"
      :active="mode !== 'idle'"
      :color="color"
      :sample="sample"
      :smoothing="SMOOTHING"
    />
  </div>
</template>

<script lang="ts">
import VisualizerBars from '@/components/player/VisualizerBars.vue'
import { getAudioEngine } from '@/services/audioEngine'
import { VisualizerEventSource } from '@/services/connect/visualizer'
import { analyserBands, resampleBands } from '@/services/visualizerBands'
import { visualizerBarColor } from '@/services/visualizerColor'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'

const SMOOTHING = 0.3
// Long enough for the bars to fall all the way before they are removed.
const SETTLE_MS = 400

/** The display in the Stats hero: the deck's own level meter. The bars exist
 * only while there is music, so an open page idling here draws nothing. */
export default {
  name: 'StatsVisualizer',
  components: { VisualizerBars },
  data() {
    return {
      SMOOTHING,
      showBars: false,
      settleTimer: null as ReturnType<typeof setTimeout> | null,
      events: null as VisualizerEventSource | null,
      castBands: null as number[] | null,
      frequencyData: null as Uint8Array<ArrayBuffer> | null,
      // The bars announce a toast of their own under reduced motion, which
      // only makes sense on the page they were switched on for.
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    }
  },
  computed: {
    playback() {
      return usePlaybackStore()
    },
    /** A phone playing by itself has no analyser, and a box that can never
     * show anything is worse than no box. */
    available(): boolean {
      if (this.reducedMotion) return false
      if (!this.playback.isCasting) return getAudioEngine().hasAnalyser
      if (this.playback.currentSong) return true
      const connect = useConnectStore()
      return connect.activeTargets.some((target) => connect.isRadioPositionCapable(target))
    },
    mode(): 'local' | 'cast' | 'idle' {
      if (!this.available || !this.playback.isPlaying) return 'idle'
      return this.playback.isCasting ? 'cast' : 'local'
    },
    color(): string {
      return visualizerBarColor(null)
    },
  },
  watch: {
    mode: {
      immediate: true,
      handler(mode: 'local' | 'cast' | 'idle') {
        if (mode === 'cast') this.startEvents()
        else this.stopEvents()

        if (this.settleTimer) clearTimeout(this.settleTimer)
        this.settleTimer = null
        if (mode !== 'idle') this.showBars = true
        else if (this.showBars) {
          this.settleTimer = setTimeout(() => (this.showBars = false), SETTLE_MS)
        }
      },
    },
  },
  beforeUnmount() {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.stopEvents()
  },
  methods: {
    startEvents(): void {
      if (this.events) return
      const auth = useAuthStore()
      this.events = new VisualizerEventSource(auth.apiUrl, auth.connectToken, auth.sessionId)
      this.events.onFrame = (frame) => {
        this.castBands = frame.bands
      }
      this.events.start()
    },
    stopEvents(): void {
      this.events?.stop()
      this.events = null
      this.castBands = null
    },
    /** Read by the bars on every frame. */
    sample(): number[] | null {
      if (this.mode !== 'local') return resampleBands(this.castBands)
      let analyser: AnalyserNode
      try {
        analyser = getAudioEngine().getAnalyser()
      } catch (error) {
        console.error('[stats] Web Audio analyser unavailable:', error)
        return null
      }
      const { heights, data } = analyserBands(analyser, this.frequencyData)
      this.frequencyData = data
      return heights
    },
  },
}
</script>

<style scoped>
/* Set into the card, with the bars standing on the floor of the recess.
 * The padding is here because a canvas's own would desync from its bitmap. */
.stats-visualizer {
  position: relative;
  width: 100%;
  max-width: 620px;
  height: clamp(96px, 10cqi, 160px);
  padding: 12px 14px 0;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(rgba(5, 6, 10, 0.7), rgba(10, 11, 16, 0.55));
  box-shadow:
    inset 0 2px 7px rgba(0, 0, 0, 0.75),
    0 1px 0 rgba(255, 255, 255, 0.07);
}

/* The bars at rest, for when they are not there at all. */
.stats-visualizer::after {
  content: '';
  position: absolute;
  right: 14px;
  bottom: 0;
  left: 14px;
  height: 1px;
  background: rgba(var(--bar), 0.5);
}
</style>
