import { describe, expect, it } from 'vitest'
import { VISUALIZER_FALLBACK, liftForContrast, visualizerBarColor } from '../visualizerColor'

describe('visualizerBarColor', () => {
  it('falls back to amber with no colour at all', () => {
    expect(visualizerBarColor(null)).toBe(VISUALIZER_FALLBACK)
  })

  it('falls back to amber for a grey background', () => {
    // What a black-and-white photo extracts to — bars drawn in it vanish
    // into the picture behind them.
    expect(visualizerBarColor('128, 128, 128')).toBe(VISUALIZER_FALLBACK)
  })

  it('falls back to amber for a near-black colour', () => {
    expect(visualizerBarColor('20, 20, 30')).toBe(VISUALIZER_FALLBACK)
  })

  it('falls back to amber for something unparseable', () => {
    expect(visualizerBarColor('not a colour')).toBe(VISUALIZER_FALLBACK)
  })

  it('lifts a dim colour to something brighter, keeping its hue', () => {
    const lifted = visualizerBarColor('100, 40, 40')
    const [r, g, b] = lifted.split(',').map((part) => Number(part.trim()))

    expect(r).toBeGreaterThan(100)
    expect(r).toBeGreaterThan(g!)
    expect(g).toBe(b)
  })

  it('keeps an already colourful background, still red-dominant', () => {
    const kept = visualizerBarColor('200, 60, 60')
    const [r, g, b] = kept.split(',').map((part) => Number(part.trim()))

    expect(r).toBeGreaterThan(g!)
    expect(r).toBeGreaterThan(b!)
  })
})

describe('liftForContrast', () => {
  /** WCAG contrast of two "r, g, b" / triplet colours. */
  function contrastOf(rgb: string, background: [number, number, number]): number {
    const lum = (channels: number[]) => {
      const [r, g, b] = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const a = lum(rgb.split(',').map(Number))
    const b = lum(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  it('lifts a violet that vanished into a violet photo until it stands off it', () => {
    // What the bars made of a stage photo bathed in violet light, over that
    // photo's bottom under the scrim.
    const behind: [number, number, number] = [52, 22, 92]
    const accent = visualizerBarColor('120, 50, 200')
    expect(contrastOf(accent, behind)).toBeLessThan(3)

    const lifted = liftForContrast(accent, behind)

    expect(contrastOf(lifted, behind)).toBeGreaterThanOrEqual(3)
    // Still violet, not white.
    const [r, g, b] = lifted.split(',').map(Number)
    expect(b!).toBeGreaterThan(g!)
    expect(r!).toBeGreaterThan(g!)
  })

  it('leaves a colour alone that already stands off what it sits on', () => {
    expect(liftForContrast('245, 169, 78', [10, 10, 14])).toBe('245, 169, 78')
  })
})
