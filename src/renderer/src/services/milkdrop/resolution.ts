import type { MilkdropVisualizer } from 'butterchurn'

/** Draws a preset in fewer pixels while the GPU cannot keep up, and in
 * more again once it can. Measured with the GPU's own clock where WebGL
 * offers one (EXT_disjoint_timer_query_webgl2: Chromium, so the desktop
 * app); elsewhere only by frames arriving late, which says when to come
 * down but never how much room there is - there the picture stays down
 * until the next preset. */

// Of a frame's 16.7 ms at 60 steps a second: above this the GPU is near
// its end (the rest of the page and the compositor need it too), below
// the lower one there is room to spare. The gap keeps a step down and a
// step up (cost goes with the pixels, the square of the scale: x0.64 and
// x1.32) from undoing each other. A Radeon RX 9070 XT draws the heaviest
// moment Beacon has (the Fractal Zoom at a minibrot) at 2560x1440 in
// 10.2 ms, below the upper mark.
const SLOW_GPU_MS = 12
const FAST_GPU_MS = 5
// Frames this far apart are slower than 40 a second - a display's own
// refresh rate (50 Hz is 20 ms) stays below it.
const SLOW_FRAME_MS = 25
// A gap this long is a pause or a hidden window, not a slow frame.
const PAUSE_MS = 250
const SAMPLES = 60
// Twice the mark or more, a weak card drawing a heavy preset at a few
// frames a second: the compositor shares that GPU, so the whole browser
// stutters with it. A handful of samples is enough to tell, and the step is
// sized to the overshoot instead of waiting a minute of 0.8s.
const OVERLOAD = 2
const QUICK_SAMPLES = 5

const STEP_DOWN = 0.8
const STEP_UP = 1.15
export const MIN_SCALE = 0.35
/** Where a preset marked demanding starts: a quarter of the pixels. One
 * that a card can afford climbs back to full size within seconds. */
export const DEMANDING_SCALE = 0.5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** The part of Butterchurn's renderer this reads, as textures.ts does. */
interface RendererInternals {
  renderer?: { gl?: WebGL2RenderingContext }
}

interface TimerQuery {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

export class RenderScale {
  /** Of the screen's own pixels, 1 for all of them. */
  scale = 1
  /** Set once the preset is far too slow even at the smallest scale: it
   * is more than this device can draw. Cleared by the next preset. */
  overloaded = false
  private readonly gl: WebGL2RenderingContext | null
  private readonly timer: TimerQuery | null
  private pending: WebGLQuery | null = null
  /** Whether the frame being drawn is the one being timed. */
  private timing = false
  private gpuMs: number[] = []
  private frameMs: number[] = []
  private lastFrameAt: number | null = null

  constructor(visualizer: MilkdropVisualizer) {
    this.gl = (visualizer as unknown as RendererInternals).renderer?.gl ?? null
    this.timer =
      (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQuery | null) ?? null
  }

  /** Before a frame is drawn: collects the last measurement, if the GPU
   * has one ready, and times this frame if none is under way. */
  begin(): void {
    const { gl, timer } = this
    if (!gl || !timer) return
    if (this.pending && gl.getQueryParameter(this.pending, gl.QUERY_RESULT_AVAILABLE)) {
      // Disjoint: the clock jumped (power state, another context), so the
      // number means nothing.
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
        this.gpuMs.push(gl.getQueryParameter(this.pending, gl.QUERY_RESULT) / 1e6)
      }
      gl.deleteQuery(this.pending)
      this.pending = null
    }
    if (!this.pending) {
      this.pending = gl.createQuery()
      if (!this.pending) return
      gl.beginQuery(timer.TIME_ELAPSED_EXT, this.pending)
      this.timing = true
    }
  }

  /** After a frame is drawn, at `now` (ms). The new scale when it should
   * change, otherwise null. */
  end(now: number): number | null {
    if (this.timing && this.gl && this.timer) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT)
      this.timing = false
    }
    if (!this.timer && this.lastFrameAt !== null && now - this.lastFrameAt < PAUSE_MS) {
      this.frameMs.push(now - this.lastFrameAt)
    }
    this.lastFrameAt = now
    return this.decide()
  }

  /** A new preset. A demanding one starts small, whatever the last one
   * got to. Otherwise, without the GPU's clock there was no telling
   * whether the last one's scale could go up again, so the new one starts
   * at full size; with it, the scale carries over. The new scale when it
   * changed, otherwise null. */
  presetChanged(demanding = false): number | null {
    this.overloaded = false
    this.gpuMs = []
    this.frameMs = []
    let next = this.scale
    if (demanding) next = Math.min(this.scale, DEMANDING_SCALE)
    else if (!this.timer) next = 1
    if (next === this.scale) return null
    this.scale = next
    return next
  }

  private decide(): number | null {
    const samples = this.timer ? this.gpuMs : this.frameMs
    const mark = this.timer ? SLOW_GPU_MS : SLOW_FRAME_MS
    if (samples.length < QUICK_SAMPLES) return null
    const took = median(samples)
    let next = this.scale
    if (took > mark * OVERLOAD) {
      // Cost goes with the pixels, the square of the scale.
      next = this.scale * Math.min(STEP_DOWN, Math.sqrt(mark / took))
      if (this.scale === MIN_SCALE) this.overloaded = true
    } else if (samples.length < SAMPLES) {
      return null
    } else if (took > mark) {
      next = this.scale * STEP_DOWN
    } else if (this.timer && took < FAST_GPU_MS) {
      next = this.scale * STEP_UP
    }
    this.gpuMs = []
    this.frameMs = []
    next = Math.min(1, Math.max(MIN_SCALE, next))
    if (next === this.scale) return null
    this.scale = next
    return next
  }
}
