<template>
  <!-- Fills the backdrop's box, over the artist image or blurred cover,
   - which stays underneath: it shows while the first preset loads, and for
   - good where WebGL 2 is missing and this never draws a frame. -->
  <div class="milkdrop">
    <canvas ref="canvas" class="milkdrop__canvas" :class="{ 'milkdrop__canvas--ready': ready }" />
    <div class="milkdrop__corner">
      <!-- Only before the first picture: later the last preset keeps
       - running while the next one compiles. -->
      <div v-if="preparing && !ready" class="milkdrop__preparing">
        <v-progress-circular indeterminate size="18" width="2" />
        <span class="text-body-medium">{{ preparingLabel }}</span>
      </div>
      <!-- Keyed by its text: a new one fades in only once the last is gone. -->
      <transition name="milkdrop-label" mode="out-in">
        <div v-if="labelVisible" :key="labelText" class="milkdrop__label display-title">
          {{ labelText }}
        </div>
      </transition>
      <div v-if="zoom" class="milkdrop__zoom">
        <span class="eyebrow-label milkdrop__zoom-label">{{ depthLabel }}</span>
        <span class="milkdrop__zoom-value"
          >2<sup>{{ zoom.exponent }}</sup></span
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { markRaw, type PropType } from 'vue'
import type { MilkdropPreset, MilkdropVisualizer } from 'butterchurn'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { themeAccent } from '@/services/appAccent'
import {
  ACCENT_SAMPLER,
  COVER_SAMPLER,
  COVER_SIZE,
  accentPicture,
  coverPicture,
  loadShippedPicture,
  placeholderPicture,
  setDataTexture,
  setTexture,
  shippedPicturesFor,
  withAccent,
  type MilkdropCover,
} from '@/services/milkdrop/textures'
import { ORBIT_LENGTH, ORBIT_SAMPLER, orbitsFor } from '@/services/milkdrop/orbits'
import { BlaKeeper } from '@/services/milkdrop/bla'
import { PictureFade, type FadePicture } from '@/services/milkdrop/pictureFade'
import { i18n } from '@/i18n'
import {
  currentCaption,
  currentZoom,
  formatZoom,
  type ZoomText,
  type MilkdropCaption,
} from '@/services/milkdrop/captions'
import { nextStep } from '@/services/milkdrop/pacing'
import { renderSize } from '@/services/milkdrop/renderSize'
import { RenderScale } from '@/services/milkdrop/resolution'
import { isDemandingPreset, loadPresetFile } from '@/services/milkdrop/presets'
import { compilePresetShaders } from '@/services/milkdrop/shaderCompile'
import { keepLoopsRolled } from '@/services/milkdrop/loops'
import { clearStarting, markTooHeavy, noteStarting } from '@/services/milkdrop/deviceLimits'
import type { PresetShaders } from 'butterchurn'

// How long a new preset blends in from the last one.
const BLEND_SECONDS = 2.7
// How long a new song's cover and accent take to fade in over the last.
const PICTURE_FADE_MS = 1500
// How long the preset's name, or a caption, stays up.
const LABEL_MS = 5000
// Butterchurn's own frame size: what it reads from an analyser per frame,
// and what connect sends per frame while casting.
const WAVEFORM_SAMPLES = 1024
const SILENCE = new Uint8Array(WAVEFORM_SAMPLES).fill(128)
// Drawn this many frames, a preset has started: a hang would have come
// before (see services/milkdrop/deviceLimits.ts).
const STARTED_FRAMES = 60

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
  /** The compile under way, called off by a newer preset or unmounting. */
  compile: AbortController | null
  /** The preset on screen's programs, for loading it again in a new
   * accent without compiling anything. */
  programs: PresetShaders<WebGLProgram> | null
  presetName: string
  /** Frames drawn of the preset on screen, up to STARTED_FRAMES. */
  framesDrawn: number
  /** Whether the preset on screen was found too heavy here already. */
  gaveUp: boolean
  /** When the next step is due (see services/milkdrop/pacing.ts). */
  nextStepAt: number
  /** The cover being fetched, so a song change can call it off. */
  coverLoad: AbortController | null
  /** The cover and the accent, each faded over from the last. */
  coverFade: PictureFade
  accentFade: PictureFade
  /** The preset on screen as loaded, to load again in a new accent. */
  presetData: MilkdropPreset | null
  /** What the preset on screen can say about itself (see captions.ts),
   * the caption it last asked for, and one waiting for the preset's name
   * to go - the name comes first. */
  captions: MilkdropCaption[] | undefined
  caption: MilkdropCaption | null
  pendingCaption: MilkdropCaption | null
  /** Whether the preset on screen reports its zoom (see captions.ts). */
  reportsZoom: boolean
  /** Fewer pixels while the GPU cannot keep up (see resolution.ts). */
  renderScale: RenderScale | null
  /** A deep zoom's table for skipping steps (see bla.ts). */
  bla: BlaKeeper
  labelIsName: boolean
}

export default {
  name: 'MilkdropVisualizer',
  props: {
    /** Frames advance only while music plays; paused, the picture holds. */
    playing: {
      type: Boolean,
      default: false,
    },
    /** The preset to show (see services/milkdrop/presets.ts's keys); a
     * change blends over to the new one. */
    preset: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** The song's cover, for the presets that work it into the picture
     * (see services/milkdrop/textures.ts). */
    cover: {
      type: Object as PropType<MilkdropCover | null>,
      default: null,
    },
    /** The colour Now Playing takes from the picture, while that is
     * switched on (Settings -> Appearance); null keeps the theme's. */
    accent: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** While casting (or on the party guest page): the latest waveform
     * connect sent, read every frame. Null plays from `analyser` instead. */
    waveform: {
      type: Function as PropType<(() => Uint8Array | null) | null>,
      default: null,
    },
    /** This device's own audio graph, for playing without `waveform` - a
     * function, so the guest page never imports the app's audio engine. */
    analyser: {
      type: Function as PropType<(() => AnalyserNode) | null>,
      default: null,
    },
  },
  emits: {
    /** `key` is more than this device can draw; it is remembered as such
     * here, and another preset should take its place. */
    'too-heavy': (key: string) => typeof key === 'string',
  },
  data() {
    return {
      ready: false,
      /** A preset's shaders are compiling. */
      preparing: false,
      labelText: '',
      labelVisible: false,
      zoom: null as ZoomText | null,
      rt: markRaw<Runtime>({
        visualizer: null,
        analyser: null,
        frame: 0,
        observer: null,
        labelTimer: undefined,
        presetKey: null,
        loadSeq: 0,
        compile: null,
        programs: null,
        presetName: '',
        framesDrawn: 0,
        gaveUp: false,
        nextStepAt: 0,
        coverLoad: null,
        coverFade: new PictureFade(COVER_SIZE, PICTURE_FADE_MS),
        accentFade: new PictureFade(1, PICTURE_FADE_MS),
        presetData: null,
        captions: undefined,
        caption: null,
        pendingCaption: null,
        reportsZoom: false,
        renderScale: null,
        bla: new BlaKeeper(),
        labelIsName: false,
      }),
    }
  },
  computed: {
    // From the i18n instance, like the zoom's digits.
    depthLabel(): string {
      return i18n.global.t('milkdrop.depth')
    },
    preparingLabel(): string {
      return i18n.global.t('milkdrop.preparing')
    },
    /** What the presets that draw in an accent draw in: the same colour
     * as the rest of Now Playing. */
    accentColour(): string {
      return this.accent ?? themeAccent.value
    },
  },
  watch: {
    preset(key: string | null) {
      void this.showPreset(key)
    },
    'cover.key'() {
      void this.showCover(this.cover)
    },
    accentColour() {
      this.showAccent()
    },
  },
  mounted() {
    const canvas = this.$refs.canvas as HTMLCanvasElement
    try {
      // Butterchurn wants an audio context even when it is handed its
      // samples: an offline one opens no audio device and plays nothing.
      const analyser = this.waveform || !this.analyser ? null : this.analyser()
      const context = analyser?.context ?? new OfflineAudioContext(2, 1, 44100)
      const { width, height } = this.canvasSize()
      canvas.width = width
      canvas.height = height
      this.rt.visualizer = butterchurn.createVisualizer(context, canvas, {
        width,
        height,
        pixelRatio: 1,
      })
      this.rt.renderScale = new RenderScale(this.rt.visualizer)
      if (analyser) this.rt.visualizer.connectAudio(analyser)
      this.rt.analyser = analyser
    } catch (error) {
      // No WebGL 2, or no analyser: the backdrop underneath stays.
      console.error('[milkdrop] Could not start:', error)
      return
    }
    canvas.addEventListener('webglcontextlost', this.contextLost)
    window.addEventListener('pagehide', this.pageHidden)
    this.rt.observer = new ResizeObserver(() => this.resize())
    this.rt.observer.observe(canvas)
    this.showAccent()
    void this.showCover(this.cover)
    void this.showPreset(this.preset)
    this.rt.frame = requestAnimationFrame(this.tick)
  },
  beforeUnmount() {
    this.rt.coverLoad?.abort()
    this.rt.coverFade.dispose()
    this.rt.accentFade.dispose()
    this.rt.compile?.abort()
    window.removeEventListener('pagehide', this.pageHidden)
    ;(this.$refs.canvas as HTMLCanvasElement | undefined)?.removeEventListener(
      'webglcontextlost',
      this.contextLost,
    )
    // Leaving is not hanging.
    if (this.rt.presetKey) clearStarting(this.rt.presetKey)
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
    canvasSize(): { width: number; height: number } {
      const rect = (this.$refs.canvas as HTMLCanvasElement).getBoundingClientRect()
      const scale = this.rt.renderScale?.scale ?? 1
      return renderSize(rect.width, rect.height, window.devicePixelRatio * scale)
    },
    resize(): void {
      const visualizer = this.rt.visualizer
      if (!visualizer) return
      const canvas = this.$refs.canvas as HTMLCanvasElement
      const { width, height } = this.canvasSize()
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      visualizer.setRendererSize(width, height, { pixelRatio: 1 })
    },
    tick(now: number): void {
      this.rt.frame = requestAnimationFrame(this.tick)
      const next = nextStep(now, this.rt.nextStepAt)
      if (next === null) return
      this.rt.nextStepAt = next
      this.stepFades(now)
      // The first frame is drawn even while paused, so a paused song still
      // shows a picture instead of a black canvas; showPreset asks for one
      // again for a preset picked while paused.
      if (!this.rt.visualizer || !this.rt.presetKey) return
      if (!this.playing && this.ready) return
      this.rt.renderScale?.begin()
      if (this.waveform) {
        // Mono: connect decodes one channel. Frames come at ~43/s, so a
        // frame at 60 Hz sometimes draws the same samples twice.
        const samples = this.waveform() ?? SILENCE
        this.rt.visualizer.render({
          audioLevels: { timeByteArray: samples, timeByteArrayL: samples, timeByteArrayR: samples },
        })
      } else {
        this.rt.visualizer.render()
      }
      if (this.rt.renderScale?.end(now) != null) this.resize()
      if (this.rt.renderScale?.overloaded) this.giveUp()
      if (this.rt.framesDrawn < STARTED_FRAMES && ++this.rt.framesDrawn === STARTED_FRAMES) {
        clearStarting(this.rt.presetKey)
      }
      this.rt.bla.update(this.rt.visualizer)
      const caption = currentCaption(this.rt.visualizer, this.rt.captions)
      if (caption !== this.rt.caption) {
        this.rt.caption = caption
        if (caption) this.showCaption(caption)
      }
      const zoom = this.rt.reportsZoom ? currentZoom(this.rt.visualizer) : null
      const zoomText = zoom === null ? null : formatZoom(zoom, String(i18n.global.locale))
      const changed = zoomText?.exponent !== this.zoom?.exponent
      // Only on a change: most frames move the factor less than it shows.
      if (changed) this.zoom = zoomText
      this.ready = true
    },
    async showPreset(key: string | null): Promise<void> {
      if (!key || key === this.rt.presetKey) return
      const seq = ++this.rt.loadSeq
      this.rt.compile?.abort()
      const compile = new AbortController()
      this.rt.compile = compile
      try {
        const file = await loadPresetFile(key)
        const preset = keepLoopsRolled(file.preset)
        // Before it starts, so its first frame has them.
        const names = shippedPicturesFor(preset)
        const pictures = await Promise.all(names.map((name) => loadShippedPicture(name)))
        if (seq !== this.rt.loadSeq || !this.rt.visualizer) return
        const loaded = withAccent(preset, this.accentColour)
        // From here on a hung GPU would take the page with it.
        noteStarting(key)
        this.preparing = true
        let programs: PresetShaders<WebGLProgram> | null
        try {
          programs = await compilePresetShaders(this.rt.visualizer, loaded, compile.signal)
        } finally {
          if (seq === this.rt.loadSeq) this.preparing = false
        }
        if (seq !== this.rt.loadSeq || !this.rt.visualizer) {
          clearStarting(key)
          return
        }
        names.forEach((name, i) => setTexture(this.rt.visualizer!, name, pictures[i]!))
        // The very first preset cuts in: there is nothing to blend from yet.
        // So does one picked while paused, drawn as a single still frame
        // like the first one - a blend nobody gets to watch would leave the
        // old picture standing.
        const blend = this.rt.presetKey && this.playing ? BLEND_SECONDS : 0
        const orbits = file.orbits?.length ? orbitsFor(file.orbits) : null
        if (orbits) {
          const rows = file.orbits!.length
          setDataTexture(this.rt.visualizer, ORBIT_SAMPLER, orbits, ORBIT_LENGTH, rows)
        }
        this.rt.bla.reset(this.rt.visualizer, orbits)
        this.rt.visualizer.loadPreset(loaded, blend, programs)
        this.rt.presetKey = key
        this.rt.programs = programs
        this.rt.presetName = file.name
        this.rt.framesDrawn = 0
        this.rt.gaveUp = false
        if (this.rt.renderScale?.presetChanged(isDemandingPreset(key)) != null) this.resize()
        this.rt.presetData = preset
        this.rt.captions = file.captions
        this.rt.caption = null
        this.rt.reportsZoom = file.reportsZoom === true
        if (!this.rt.reportsZoom) this.zoom = null
        if (!this.playing) this.ready = false
        this.announce(file.name)
      } catch (error) {
        if (compile.signal.aborted) return
        // A preset Butterchurn cannot compile; the last one keeps running.
        clearStarting(key)
        console.error('[milkdrop] Preset failed:', key, error)
      }
    },
    /** Far too slow even at the smallest size: remembered for this device,
     * said in the corner, and handed back for another preset. */
    giveUp(): void {
      const key = this.rt.presetKey
      if (!key || this.rt.gaveUp) return
      this.rt.gaveUp = true
      markTooHeavy(key)
      clearStarting(key)
      this.showLabel(
        { text: i18n.global.t('milkdrop.tooHeavy', { name: this.rt.presetName }) },
        true,
      )
      this.$emit('too-heavy', key)
    },
    /** The GPU process gave up on the context - a driver reset, most often
     * under a preset too heavy for the card. Nothing draws from here on;
     * the backdrop underneath shows again. */
    contextLost(): void {
      cancelAnimationFrame(this.rt.frame)
      this.rt.compile?.abort()
      this.rt.visualizer = null
      this.ready = false
      this.preparing = false
      const key = this.rt.presetKey
      if (key && !this.rt.gaveUp) {
        this.rt.gaveUp = true
        markTooHeavy(key)
        clearStarting(key)
        this.$emit('too-heavy', key)
      }
    },
    /** Closed normally: not a hang. */
    pageHidden(): void {
      if (this.rt.presetKey) clearStarting(this.rt.presetKey)
    },
    /** The accent, for the presets that draw in it. The waveform's colour
     * is fixed when a preset loads, so one that draws a waveform loads
     * again in the new colour - blended while playing, since a colour taken
     * from the picture changes with every song and a cut would restart its
     * trails. Any other gets the accent through its texture alone and keeps
     * running (withAccent leaves it as it is), so the song changing does not
     * start it over. */
    showAccent(): void {
      const visualizer = this.rt.visualizer
      if (!visualizer) return
      setTexture(
        visualizer,
        ACCENT_SAMPLER,
        this.rt.accentFade.show(accentPicture(this.accentColour), performance.now()),
      )
      const preset = this.rt.presetData
      if (preset && withAccent(preset, this.accentColour) !== preset) {
        // The colour is no part of the shaders: the programs carry over.
        visualizer.loadPreset(
          withAccent(preset, this.accentColour),
          this.playing && this.ready ? BLEND_SECONDS : 0,
          this.rt.programs,
        )
      }
    },
    async showCover(cover: MilkdropCover | null): Promise<void> {
      this.rt.coverLoad?.abort()
      this.rt.coverLoad = null
      const visualizer = this.rt.visualizer
      if (!visualizer) return
      if (!cover) {
        this.putCover(visualizer, placeholderPicture())
        return
      }
      const load = new AbortController()
      this.rt.coverLoad = load
      try {
        const blob = await cover.load(load.signal)
        const picture = blob ? await coverPicture(blob) : null
        if (load.signal.aborted || this.rt.visualizer !== visualizer) {
          picture?.close()
          return
        }
        // No art for this song: calm grey rather than the last song's cover.
        this.putCover(visualizer, picture ?? placeholderPicture())
      } catch (error) {
        if (load.signal.aborted) return
        console.error('[milkdrop] Cover failed:', cover.key, error)
        this.putCover(visualizer, placeholderPicture())
      }
    },
    putCover(visualizer: MilkdropVisualizer, picture: FadePicture): void {
      setTexture(visualizer, COVER_SAMPLER, this.rt.coverFade.show(picture, performance.now()))
    },
    stepFades(now: number): void {
      const visualizer = this.rt.visualizer
      if (!visualizer) return
      const cover = this.rt.coverFade.step(now)
      if (cover) setTexture(visualizer, COVER_SAMPLER, cover)
      const accent = this.rt.accentFade.step(now)
      if (accent) setTexture(visualizer, ACCENT_SAMPLER, accent)
    },
    announce(name: string): void {
      this.rt.pendingCaption = null
      this.showLabel({ text: name }, true)
    },
    showCaption(caption: MilkdropCaption): void {
      if (this.rt.labelIsName) this.rt.pendingCaption = caption
      else this.showLabel(caption, false)
    },
    showLabel(caption: MilkdropCaption, isName: boolean): void {
      this.labelText = caption.text
      this.labelVisible = true
      this.rt.labelIsName = isName
      clearTimeout(this.rt.labelTimer)
      this.rt.labelTimer = setTimeout(() => {
        const pending = this.rt.pendingCaption
        this.rt.pendingCaption = null
        if (pending) {
          this.showLabel(pending, false)
          return
        }
        this.labelVisible = false
        this.rt.labelIsName = false
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
  /* What Now Playing's type scale measures against here (see its
   * --now-playing-title-size), as the title does against the stage. */
  container-type: size;
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
 * one can be told apart from the rest - and what a preset says about
 * itself. Bottom right, clear of the toolbar (top right) and the debug
 * overlays (top left). Raised over Now Playing's scrims, which sit above
 * the picture and would turn white text grey. */
.milkdrop__corner {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 2;
  max-width: calc(100% - 48px);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  text-align: right;
  color: #fff;
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.8),
    0 0 12px rgba(0, 0, 0, 0.5);
}

.milkdrop__preparing {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Half a second each way: a change, out and in, takes one. */
.milkdrop-label-enter-active,
.milkdrop-label-leave-active {
  transition: opacity 0.5s ease;
}

.milkdrop-label-enter-from,
.milkdrop-label-leave-to {
  opacity: 0;
}

/* Set like the song title, at its size; the fallback is for a picture
 * outside Now Playing. */
.milkdrop__label {
  font-size: var(--now-playing-title-size, 2rem);
}

/* A small label over a large, light figure - the zoom reads as a gauge
 * rather than one more line of text. */
.milkdrop__zoom {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-top: 6px;
}

/* The eyebrow's amber is lost on a bright fractal; white, toned down. */
.milkdrop__zoom-label {
  color: rgba(255, 255, 255, 0.72);
}

.milkdrop__zoom-value {
  font-size: calc(var(--now-playing-album-size, 1rem) * 2);
  font-weight: 300;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.milkdrop__zoom-value sup {
  /* Raised without pushing the line apart, and as wide for 9 as for 99,
   * so the 2 holds still while the power counts up. */
  display: inline-block;
  min-width: 2ch;
  font-size: 0.5em;
  font-weight: 500;
  line-height: 0;
  text-align: left;
  vertical-align: 1.1em;
}
</style>
