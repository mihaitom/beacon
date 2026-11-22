<template>
  <!-- Fills the backdrop's box, over the artist image or blurred cover,
   - which stays underneath: it shows while the first preset loads, and for
   - good where WebGL 2 is missing and this never draws a frame. -->
  <div class="milkdrop">
    <canvas ref="canvas" class="milkdrop__canvas" :class="{ 'milkdrop__canvas--ready': ready }" />
    <div
      class="milkdrop__preset text-body-small"
      :class="{ 'milkdrop__preset--visible': labelVisible }"
    >
      {{ presetName }}
    </div>
  </div>
</template>

<script lang="ts">
import { markRaw } from 'vue'
import type { MilkdropVisualizer } from 'butterchurn'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { getAudioEngine } from '@/services/audioEngine'
import { MILKDROP_PRESET_KEYS, loadPresetFile, pickPresetKey } from '@/services/milkdrop/presets'

// Rendering at full size on a 4K screen costs a lot of GPU for no visible
// gain: Milkdrop is all blur and feedback, and upscaling hides nothing
// there. A first guess, not yet measured on anything but one desktop.
const MAX_RENDER_EDGE = 1280
// How long a new preset blends in from the last one.
const BLEND_SECONDS = 2.7
// How long the preset's name stays up after it changes.
const LABEL_MS = 5000

// Kept raw: Vue proxying Butterchurn's WebGL state would be slow, and the
// render loop changes none of what the template shows.
interface Runtime {
  visualizer: MilkdropVisualizer | null
  analyser: AnalyserNode | null
  frame: number
  observer: ResizeObserver | null
  labelTimer: ReturnType<typeof setTimeout> | undefined
  presetKey: string | null
  /** Bumped per preset request, so a slow load cannot replace a newer one. */
  loadSeq: number
}

export default {
  name: 'MilkdropVisualizer',
  props: {
    /** Frames advance only while music plays; paused, the picture holds. */
    playing: {
      type: Boolean,
      default: false,
    },
    /** In [0, 1): which preset to show. A new seed means a new preset. */
    seed: {
      type: Number,
      required: true,
    },
  },
  data() {
    return {
      ready: false,
      presetName: '',
      labelVisible: false,
      rt: markRaw<Runtime>({
        visualizer: null,
        analyser: null,
        frame: 0,
        observer: null,
        labelTimer: undefined,
        presetKey: null,
        loadSeq: 0,
      }),
    }
  },
  watch: {
    seed(seed: number) {
      void this.showPreset(seed)
    },
  },
  mounted() {
    const canvas = this.$refs.canvas as HTMLCanvasElement
    try {
      const analyser = getAudioEngine().getAnalyser()
      const { width, height } = this.renderSize()
      canvas.width = width
      canvas.height = height
      this.rt.visualizer = butterchurn.createVisualizer(analyser.context, canvas, {
        width,
        height,
        pixelRatio: 1,
      })
      this.rt.visualizer.connectAudio(analyser)
      this.rt.analyser = analyser
    } catch (error) {
      // No WebGL 2, or no analyser: the backdrop underneath stays.
      console.error('[milkdrop] Could not start:', error)
      return
    }
    this.rt.observer = new ResizeObserver(() => this.resize())
    this.rt.observer.observe(canvas)
    void this.showPreset(this.seed)
    this.rt.frame = requestAnimationFrame(this.tick)
  },
  beforeUnmount() {
    cancelAnimationFrame(this.rt.frame)
    clearTimeout(this.rt.labelTimer)
    this.rt.observer?.disconnect()
    if (this.rt.visualizer && this.rt.analyser) {
      this.rt.visualizer.disconnectAudio(this.rt.analyser)
    }
    this.rt.visualizer = null
    // Hands the GPU memory back now rather than whenever the canvas is
    // collected - switching Milkdrop off and on would otherwise pile up
    // contexts until the browser starts dropping the oldest.
    const canvas = this.$refs.canvas as HTMLCanvasElement | undefined
    canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
  },
  methods: {
    renderSize(): { width: number; height: number } {
      const canvas = this.$refs.canvas as HTMLCanvasElement
      const rect = canvas.getBoundingClientRect()
      const cssWidth = Math.max(1, rect.width)
      const cssHeight = Math.max(1, rect.height)
      const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(cssWidth, cssHeight))
      return {
        width: Math.max(1, Math.round(cssWidth * scale)),
        height: Math.max(1, Math.round(cssHeight * scale)),
      }
    },
    resize(): void {
      const visualizer = this.rt.visualizer
      if (!visualizer) return
      const canvas = this.$refs.canvas as HTMLCanvasElement
      const { width, height } = this.renderSize()
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      visualizer.setRendererSize(width, height, { pixelRatio: 1 })
    },
    tick(): void {
      this.rt.frame = requestAnimationFrame(this.tick)
      // The first frame is drawn even while paused, so a paused song still
      // shows a picture instead of a black canvas.
      if (!this.rt.visualizer || !this.rt.presetKey) return
      if (!this.playing && this.ready) return
      this.rt.visualizer.render()
      this.ready = true
    },
    async showPreset(seed: number): Promise<void> {
      const key = pickPresetKey(MILKDROP_PRESET_KEYS, seed, this.rt.presetKey)
      if (!key || key === this.rt.presetKey) return
      const seq = ++this.rt.loadSeq
      try {
        const file = await loadPresetFile(key)
        if (seq !== this.rt.loadSeq || !this.rt.visualizer) return
        // The very first preset cuts in: there is nothing to blend from yet.
        this.rt.visualizer.loadPreset(file.preset, this.rt.presetKey ? BLEND_SECONDS : 0)
        this.rt.presetKey = key
        this.announce(file.name)
      } catch (error) {
        // A preset Butterchurn cannot compile; the last one keeps running.
        console.error('[milkdrop] Preset failed:', key, error)
      }
    },
    announce(name: string): void {
      this.presetName = name
      this.labelVisible = true
      clearTimeout(this.rt.labelTimer)
      this.rt.labelTimer = setTimeout(() => {
        this.labelVisible = false
      }, LABEL_MS)
    },
  },
}
</script>

<style scoped>
.milkdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.milkdrop__canvas {
  width: 100%;
  height: 100%;
  display: block;
  opacity: 0;
  transition: opacity 0.6s ease;
}

.milkdrop__canvas--ready {
  opacity: 1;
}

/* Where the preset's name shows for a moment after it changes - so a good
 * one can be told apart from the rest. Bottom left, clear of the toolbar
 * (top right) and the debug overlays (top left). */
.milkdrop__preset {
  position: absolute;
  left: 24px;
  bottom: 24px;
  max-width: calc(100% - 48px);
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transition: opacity 0.6s ease;
}

.milkdrop__preset--visible {
  opacity: 1;
}
</style>
