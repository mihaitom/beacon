import { describe, expect, it } from 'vitest'
import type { MilkdropVisualizer } from 'butterchurn'
import { currentCaption, currentZoom, formatZoom } from '../captions'

function after(qs: Record<string, unknown> | null): MilkdropVisualizer {
  return {
    renderer: { presetEquationRunner: { mdVSQAfterFrame: qs } },
  } as unknown as MilkdropVisualizer
}

const CAPTIONS = [{ text: 'Mandelbrot set' }, { text: 'Seahorse Valley' }]

describe('currentCaption', () => {
  it('reads the caption the last frame asked for, counting from 1', () => {
    expect(currentCaption(after({ q32: 1 }), CAPTIONS)).toBe(CAPTIONS[0])
    expect(currentCaption(after({ q32: 2 }), CAPTIONS)).toBe(CAPTIONS[1])
  })

  it('has none for 0, a number past the list, or a preset without captions', () => {
    expect(currentCaption(after({ q32: 0 }), CAPTIONS)).toBeNull()
    expect(currentCaption(after({ q32: 3 }), CAPTIONS)).toBeNull()
    expect(currentCaption(after({ q32: 1 }), undefined)).toBeNull()
  })

  it('has none before the first frame, or from a Butterchurn laid out otherwise', () => {
    expect(currentCaption(after(null), CAPTIONS)).toBeNull()
    expect(currentCaption({} as MilkdropVisualizer, CAPTIONS)).toBeNull()
  })
})

describe('currentZoom', () => {
  it('reads the doublings the last frame reported', () => {
    expect(currentZoom(after({ q31: 12.5 }))).toBe(12.5)
    expect(currentZoom(after({ q31: Number.NaN }))).toBeNull()
    expect(currentZoom(after(null))).toBeNull()
  })
})

describe('formatZoom', () => {
  it('writes small factors in full', () => {
    expect(formatZoom(0, 'en')).toEqual({ factor: '1', exponent: null })
    expect(formatZoom(Math.log2(850), 'en')).toEqual({ factor: '850', exponent: null })
    expect(formatZoom(Math.log2(9000), 'de')).toEqual({ factor: '9.000', exponent: null })
  })

  it('writes large ones as a power of ten, in the locale', () => {
    expect(formatZoom(Math.log2(3.4e24), 'en')).toEqual({ factor: '3.4', exponent: '24' })
    expect(formatZoom(Math.log2(3.4e24), 'de')).toEqual({ factor: '3,4', exponent: '24' })
    expect(formatZoom(Math.log2(20_000), 'en')).toEqual({ factor: '2.0', exponent: '4' })
  })

  it('carries a mantissa that rounds up to ten', () => {
    expect(formatZoom(Math.log2(9.97e12), 'en')).toEqual({ factor: '1.0', exponent: '13' })
  })
})
