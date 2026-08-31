import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SongWaveform from '../SongWaveform.vue'

const CANVAS_WIDTH = 200
const CANVAS_HEIGHT = 24
const PLAYED_COLOR = 'rgba(245, 169, 78, 0.85)'
const MARKER_COLOR = 'rgba(255, 255, 255, 0.9)'

interface FillRectCall {
  style: string
  x: number
  y: number
  w: number
  h: number
}

/** Stands in for the 2D context paint() draws through, recording every
 * fillRect() call together with whatever fillStyle was set right before
 * it — canvas has no way to ask "what did you draw", so this is the only
 * way to assert on the shapes actually produced. Also stubs
 * getBoundingClientRect(): jsdom reports every element as 0x0, which
 * resizeCanvas() would otherwise turn into a 1x1 canvas too small for any
 * of the ratios below to mean anything. */
function stubCanvas(): FillRectCall[] {
  const calls: FillRectCall[] = []
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
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ style: ctx.fillStyle, x, y, w, h })
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  )
  return calls
}

// No currentSong in a fresh store, so songId is null and loadPeaks() never
// populates `peaks` — every mount here exercises paint()'s no-peaks
// branch, same as a real track whose waveform hasn't loaded yet.
function mountWaveform(props: {
  modelValue: number
  duration: number
  disabled?: boolean
  dimmed?: boolean
}) {
  return mount(SongWaveform, { props })
}

describe('SongWaveform', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('the no-peaks band (a track whose waveform has not loaded yet)', () => {
    it('draws a played band and a marker sized to modelValue/duration', () => {
      const calls = stubCanvas()

      mountWaveform({ modelValue: 60, duration: 240, disabled: true })

      const played = calls.find((c) => c.style === PLAYED_COLOR)
      expect(played?.w).toBeCloseTo((60 / 240) * CANVAS_WIDTH, 5)

      const marker = calls.filter((c) => c.style === MARKER_COLOR).at(-1)
      expect(marker?.x).toBeCloseTo((60 / 240) * CANVAS_WIDTH, 5)
    })

    it('clamps to the visible width if position ever lands past duration', () => {
      const calls = stubCanvas()

      mountWaveform({ modelValue: 500, duration: 240, disabled: true })

      const played = calls.filter((c) => c.style === PLAYED_COLOR).at(-1)
      expect(played?.w).toBe(CANVAS_WIDTH)
      const marker = calls.filter((c) => c.style === MARKER_COLOR).at(-1)
      expect(marker!.x).toBeLessThanOrEqual(CANVAS_WIDTH)
    })

    it('draws nothing played at duration 0, rather than a marker with no reference at all', () => {
      const calls = stubCanvas()

      mountWaveform({ modelValue: 0, duration: 0, disabled: true })

      expect(calls.some((c) => c.style === PLAYED_COLOR)).toBe(false)
    })
  })

  describe('dimmed', () => {
    it('is independent of disabled', () => {
      stubCanvas()
      const wrapper1 = mountWaveform({ modelValue: 0, duration: 0, disabled: true, dimmed: true })
      expect(wrapper1.classes()).toContain('song-waveform--disabled')
      expect(wrapper1.classes()).toContain('song-waveform--dimmed')

      const wrapper2 = mountWaveform({
        modelValue: 60,
        duration: 240,
        disabled: true,
        dimmed: false,
      })
      expect(wrapper2.classes()).toContain('song-waveform--disabled')
      expect(wrapper2.classes()).not.toContain('song-waveform--dimmed')
    })
  })
})
