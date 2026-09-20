import { describe, expect, it } from 'vitest'
import { VISUALIZER_FALLBACK, visualizerBarColor } from '../visualizerColor'

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
