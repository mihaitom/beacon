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
  it('writes the factor as a whole power of two', () => {
    expect(formatZoom(0, 'en')).toEqual({ exponent: '0' })
    expect(formatZoom(36.6, 'en')).toEqual({ exponent: '37' })
    expect(formatZoom(1000, 'de')).toEqual({ exponent: '1000' })
  })

  it('never goes below 2^0 while a zoom backs out past its start', () => {
    expect(formatZoom(-1.4, 'en')).toEqual({ exponent: '0' })
  })
})
