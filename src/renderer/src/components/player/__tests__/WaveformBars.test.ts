import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WaveformBars, { resamplePeaks } from '../WaveformBars.vue'
import { DEFAULT_APP_ACCENT, appAccent } from '@/services/appAccent'

// Deliberately not a whole number of bar+gap steps, so the leftover has to
// go somewhere.
const CANVAS_WIDTH = 201
const CANVAS_HEIGHT = 24
const UNPLAYED_COLOR = 'rgba(255, 255, 255, 0.22)'

interface BarCall {
  style: string
  x: number
  y: number
  w: number
  h: number
}

/** Records every roundRect() the bars are drawn with, together with the
 * fillStyle in effect - see SongWaveform.test.ts for why a stub is the only
 * way to see what a canvas drew. */
function stubCanvas(): BarCall[] {
  const calls: BarCall[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    top: 0,
    left: 0,
    right: CANVAS_WIDTH,
    bottom: CANVAS_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect)
  const ctx = {
    fillStyle: '',
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    fill: () => {},
    roundRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ style: ctx.fillStyle, x, y, w, h })
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  )
  return calls
}

function mountBars(peaks: number[], modelValue = 0, duration = 240) {
  appAccent.value = DEFAULT_APP_ACCENT
  return mount(WaveformBars, { props: { peaks, modelValue, duration } })
}

describe('resamplePeaks', () => {
  it('keeps a single loud peak when there are fewer bars than peaks', () => {
    const peaks = Array.from({ length: 300 }, () => 0.1)
    // First in its bucket, so taking any other peak of the bucket loses it.
    peaks[147] = 1

    const bars = resamplePeaks(peaks, 67)

    expect(bars).toHaveLength(67)
    expect(Math.max(...bars)).toBe(1)
    expect(bars.filter((b) => b === 1)).toHaveLength(1)
  })

  it('repeats peaks when there are more bars than peaks', () => {
    expect(resamplePeaks([0.2, 0.8], 4)).toEqual([0.2, 0.2, 0.8, 0.8])
  })
})

describe('WaveformBars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spaces the bars apart and spans the full width, however many peaks there are', () => {
    for (const peakCount of [30, 300, 3000]) {
      const calls = stubCanvas()
      mountBars(Array.from({ length: peakCount }, () => 0.5))

      const bars = [...calls].sort((a, b) => a.x - b.x)
      expect(bars.length).toBeGreaterThan(1)
      for (let i = 1; i < bars.length; i++) {
        expect(bars[i]!.x - (bars[i - 1]!.x + bars[i - 1]!.w)).toBeGreaterThanOrEqual(1)
      }
      expect(bars[0]!.x).toBe(0)
      expect(bars.at(-1)!.x + bars.at(-1)!.w).toBeCloseTo(CANVAS_WIDTH, 5)
      vi.restoreAllMocks()
    }
  })

  it('colours the bars before the playhead as played and the rest as unplayed', () => {
    const calls = stubCanvas()
    mountBars(
      Array.from({ length: 300 }, () => 0.5),
      60,
      240,
    )

    const playheadX = (60 / 240) * CANVAS_WIDTH
    expect(calls.some((c) => c.style !== UNPLAYED_COLOR)).toBe(true)
    for (const bar of calls) {
      const isPlayed = bar.style !== UNPLAYED_COLOR
      expect(bar.x + bar.w / 2 < playheadX).toBe(isPlayed)
    }
  })

  it('draws a louder peak as a taller bar', () => {
    const calls = stubCanvas()
    mountBars([0.2, 1])

    const [quiet, loud] = [...calls]
      .sort((a, b) => a.x - b.x)
      .filter((_, i, all) => i === 0 || i === all.length - 1)
    expect(loud!.h).toBeGreaterThan(quiet!.h)
  })

  describe('playhead between position updates', () => {
    const DURATION = 30

    /** x of the playhead marker in the latest paint, in canvas pixels. */
    function trackPlayhead(): () => number {
      stubCanvas()
      const ctx = HTMLCanvasElement.prototype.getContext('2d') as unknown as {
        fillRect: (x: number, y: number, w: number, h: number) => void
      }
      let markerX = NaN
      ctx.fillRect = (x, y, _w, h) => {
        if (y === 0 && h === CANVAS_HEIGHT) markerX = x
      }
      return () => markerX
    }

    function mountPlaying(modelValue: number, playing: boolean) {
      appAccent.value = DEFAULT_APP_ACCENT
      return mount(WaveformBars, {
        props: { peaks: [0.5, 0.5], modelValue, duration: DURATION, playing },
      })
    }

    const xAt = (seconds: number) => (seconds / DURATION) * CANVAS_WIDTH

    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs on in real time while playing', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const playhead = trackPlayhead()
      mountPlaying(10, true)

      vi.advanceTimersByTime(200)

      expect(playhead()).toBeCloseTo(xAt(10.2), 0)
    })

    it('stops running on half a second after the last update', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const playhead = trackPlayhead()
      mountPlaying(10, true)

      vi.advanceTimersByTime(3000)

      expect(playhead()).toBeCloseTo(xAt(10.5), 0)
    })

    it('stays on the reported position while paused', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const playhead = trackPlayhead()
      mountPlaying(10, false)

      vi.advanceTimersByTime(1000)

      expect(playhead()).toBeCloseTo(xAt(10), 5)
    })

    it('does not step back for an update just behind it, but does for a seek', async () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const playhead = trackPlayhead()
      const wrapper = mountPlaying(10, true)
      vi.advanceTimersByTime(300)
      const ahead = playhead()

      await wrapper.setProps({ modelValue: 10.2 })
      vi.advanceTimersByTime(20)
      expect(playhead()).toBeGreaterThanOrEqual(ahead)

      await wrapper.setProps({ modelValue: 2 })
      vi.advanceTimersByTime(20)
      expect(playhead()).toBeLessThan(xAt(3))
    })
  })
})
