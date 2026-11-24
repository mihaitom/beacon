import { describe, expect, it } from 'vitest'
import type { MilkdropVisualizer } from 'butterchurn'
import { DEMANDING_SCALE, MIN_SCALE, RenderScale } from '../resolution'

/** A visualizer whose GPU takes `gpuMs()` per frame - or, without
 * `gpuMs`, one that has no GPU clock to read. */
function visualizer(gpuMs?: () => number, disjoint = () => false): MilkdropVisualizer {
  const timer = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }
  const gl = {
    QUERY_RESULT_AVAILABLE: 3,
    QUERY_RESULT: 4,
    getExtension: (name: string) =>
      gpuMs && name === 'EXT_disjoint_timer_query_webgl2' ? timer : null,
    createQuery: () => ({}),
    deleteQuery: () => {},
    beginQuery: () => {},
    endQuery: () => {},
    getQueryParameter: (_query: unknown, what: number) => (what === 3 ? true : gpuMs!() * 1e6),
    getParameter: (what: number) => (what === 2 ? disjoint() : 0),
  }
  return { renderer: { gl } } as unknown as MilkdropVisualizer
}

/** Draws `count` frames `apart` ms apart; the scales it changed to. */
function draw(scale: RenderScale, count: number, apart = 16.7, from = { at: 0 }): number[] {
  const changes: number[] = []
  for (let frame = 0; frame < count; frame++) {
    scale.begin()
    from.at += apart
    const next = scale.end(from.at)
    if (next !== null) changes.push(next)
  }
  return changes
}

describe('RenderScale, with the GPU clock', () => {
  it('comes down a step at a time while the GPU is slow, never below the floor', () => {
    const scale = new RenderScale(visualizer(() => 15))
    expect(draw(scale, 61)).toEqual([0.8])
    draw(scale, 2000)
    expect(scale.scale).toBe(MIN_SCALE)
  })

  it('goes back up once there is room, no further than full size', () => {
    let gpu = 15
    const scale = new RenderScale(visualizer(() => gpu))
    draw(scale, 200)
    expect(scale.scale).toBeLessThan(1)
    gpu = 3
    draw(scale, 2000)
    expect(scale.scale).toBe(1)
  })

  it('stays where it is between the two marks', () => {
    const scale = new RenderScale(visualizer(() => 8))
    expect(draw(scale, 500)).toEqual([])
  })

  it('ignores a measurement the GPU clock jumped during', () => {
    const scale = new RenderScale(
      visualizer(
        () => 15,
        () => true,
      ),
    )
    expect(draw(scale, 500)).toEqual([])
  })

  it('drops at once, and by more, when the GPU is far behind', () => {
    const scale = new RenderScale(visualizer(() => 48))
    const [first] = draw(scale, 6)
    // Four times the pixels' worth too slow: half the scale.
    expect(first).toBeCloseTo(0.5)
    expect(scale.overloaded).toBe(false)
  })

  it('gives up on a preset that is far too slow even at the floor', () => {
    const scale = new RenderScale(visualizer(() => 96))
    draw(scale, 30)
    expect(scale.scale).toBe(MIN_SCALE)
    expect(scale.overloaded).toBe(true)
    scale.presetChanged()
    expect(scale.overloaded).toBe(false)
  })

  it('does not give up on one that is merely slow at the floor', () => {
    const scale = new RenderScale(visualizer(() => 15))
    draw(scale, 2000)
    expect(scale.overloaded).toBe(false)
  })

  it('starts a demanding preset small, and lets it climb when there is room', () => {
    const scale = new RenderScale(visualizer(() => 3))
    expect(scale.presetChanged(true)).toBe(DEMANDING_SCALE)
    draw(scale, 2000)
    expect(scale.scale).toBe(1)
  })

  it('has its own measure for a new preset, so keeps its scale', () => {
    const scale = new RenderScale(visualizer(() => 15))
    draw(scale, 61)
    expect(scale.presetChanged()).toBeNull()
    expect(scale.scale).toBe(0.8)
  })
})

describe('RenderScale, without it', () => {
  it('comes down while frames arrive late, and never goes up by itself', () => {
    const scale = new RenderScale(visualizer())
    const clock = { at: 0 }
    expect(draw(scale, 61, 30, clock)).toEqual([0.8])
    expect(draw(scale, 500, 16.7, clock)).toEqual([])
  })

  it('takes a pause for a pause, not a slow frame', () => {
    const scale = new RenderScale(visualizer())
    expect(draw(scale, 500, 1000)).toEqual([])
  })

  it('starts a new preset at full size again', () => {
    const scale = new RenderScale(visualizer())
    draw(scale, 61, 30)
    expect(scale.presetChanged()).toBe(1)
    expect(scale.scale).toBe(1)
    expect(scale.presetChanged()).toBeNull()
  })

  it('drops at once when frames come far too late, and gives up at the floor', () => {
    const scale = new RenderScale(visualizer())
    const clock = { at: 0 }
    expect(draw(scale, 6, 200, clock)[0]).toBeLessThan(0.5)
    draw(scale, 60, 200, clock)
    expect(scale.overloaded).toBe(true)
  })

  it('starts a demanding preset small, and a light one at full size', () => {
    const scale = new RenderScale(visualizer())
    expect(scale.presetChanged(true)).toBe(DEMANDING_SCALE)
    expect(scale.presetChanged(false)).toBe(1)
  })

  it('works without a renderer to read at all', () => {
    const scale = new RenderScale({} as MilkdropVisualizer)
    expect(draw(scale, 61, 30)).toEqual([0.8])
  })
})
