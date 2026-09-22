import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SongWaveform from '../SongWaveform.vue'
import { DEFAULT_APP_ACCENT, appAccent } from '@/services/appAccent'

const CANVAS_WIDTH = 200
const CANVAS_HEIGHT = 24
const PLAYED_COLOR = 'rgba(245, 169, 78, 0.85)'
const UNPLAYED_COLOR = 'rgba(255, 255, 255, 0.22)'
const MARKER_COLOR = 'rgba(255, 255, 255, 0.9)'
const LOAD_BAR_COLOR = 'rgba(245, 169, 78, 0.75)'
const LOAD_TRACK_COLOR = 'rgba(255, 255, 255, 0.1)'

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
  buffered?: number
  disabled?: boolean
  dimmed?: boolean
}) {
  return mount(SongWaveform, { props })
}

describe('SongWaveform', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    appAccent.value = DEFAULT_APP_ACCENT
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('accent', () => {
    it('draws the played bars and the load fill in the app accent', () => {
      const calls = stubCanvas()
      appAccent.value = '10, 20, 30'

      mountWaveform({ modelValue: 60, duration: 240, buffered: 180, disabled: true })

      expect(calls.some((c) => c.style === 'rgba(10, 20, 30, 0.85)')).toBe(true)
      expect(calls.some((c) => c.style === 'rgba(10, 20, 30, 0.75)')).toBe(true)
    })

    it('repaints in a borrowed accent instead of waiting for the next tick', async () => {
      const calls = stubCanvas()
      mountWaveform({ modelValue: 60, duration: 240, disabled: true })

      appAccent.value = '10, 20, 30'
      await nextTick()

      expect(calls.some((c) => c.style === 'rgba(10, 20, 30, 0.85)')).toBe(true)
    })
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

  describe('the load bar', () => {
    it('is filled up to where the stream has got to, with an empty track beyond it', () => {
      const calls = stubCanvas()

      mountWaveform({ modelValue: 60, duration: 240, buffered: 180, disabled: true })

      const bufferedX = (180 / 240) * CANVAS_WIDTH
      const loaded = calls.filter((c) => c.style === LOAD_BAR_COLOR)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]!.x).toBe(0)
      expect(loaded[0]!.w).toBeCloseTo(bufferedX, 5)

      const track = calls.filter((c) => c.style === LOAD_TRACK_COLOR)
      expect(track).toHaveLength(1)
      expect(track[0]!.x).toBeCloseTo(bufferedX, 5)
      expect(track[0]!.x + track[0]!.w).toBeCloseTo(CANVAS_WIDTH, 5)
    })

    it('draws nothing at all for a source with no buffer to report', () => {
      // Casting and radio both pass 0 — the device buffers out of this
      // app's reach, so there is nothing honest to draw, not even an
      // empty track that would read as "nothing is loaded".
      const calls = stubCanvas()

      mountWaveform({ modelValue: 60, duration: 240, buffered: 0, disabled: true })

      expect(calls.some((c) => c.style === LOAD_BAR_COLOR)).toBe(false)
      expect(calls.some((c) => c.style === LOAD_TRACK_COLOR)).toBe(false)
    })

    it('ends short of the playhead after a seek forward into nothing', () => {
      // The buffered figure lags a seek by a moment: the element reports a
      // new one only once it has fetched something at the new position.
      // The gap between the fill and the playhead is the honest picture
      // there, not something to paper over.
      const calls = stubCanvas()

      mountWaveform({ modelValue: 200, duration: 240, buffered: 45, disabled: true })

      const loaded = calls.find((c) => c.style === LOAD_BAR_COLOR)!
      expect(loaded.x + loaded.w).toBeLessThan((200 / 240) * CANVAS_WIDTH)
    })

    it('leaves the waveform itself clear of it', () => {
      // The whole point of the separate strip: position lives in the bars,
      // loading state below them. An overlap would put them back on one
      // channel.
      const calls = stubCanvas()

      mountWaveform({ modelValue: 60, duration: 240, buffered: 180, disabled: true })

      const loadBarTop = calls.find((c) => c.style === LOAD_TRACK_COLOR)!.y
      const bars = calls.filter((c) => c.style === PLAYED_COLOR || c.style === UNPLAYED_COLOR)
      expect(bars.length).toBeGreaterThan(0)
      for (const bar of bars) expect(bar.y + bar.h).toBeLessThan(loadBarTop)
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
