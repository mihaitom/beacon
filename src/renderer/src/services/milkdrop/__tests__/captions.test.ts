import { describe, expect, it } from 'vitest'
import type { MilkdropVisualizer } from 'butterchurn'
import { currentCaption } from '../captions'

function after(qs: Record<string, unknown> | null): MilkdropVisualizer {
  return {
    renderer: { presetEquationRunner: { mdVSQAfterFrame: qs } },
  } as unknown as MilkdropVisualizer
}

const CAPTIONS = ['Mandelbrot set', 'Seahorse Valley']

describe('currentCaption', () => {
  it('reads the caption the last frame asked for, counting from 1', () => {
    expect(currentCaption(after({ q32: 1 }), CAPTIONS)).toBe('Mandelbrot set')
    expect(currentCaption(after({ q32: 2 }), CAPTIONS)).toBe('Seahorse Valley')
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
