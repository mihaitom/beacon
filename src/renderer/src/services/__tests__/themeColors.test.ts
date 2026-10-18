import { describe, expect, it } from 'vitest'
import {
  contrast,
  hexToTriplet,
  isDarkColor,
  isHexColor,
  mix,
  towardsContrast,
  tripletToHex,
} from '../themeColors'

describe('themeColors', () => {
  it('measures contrast the way WCAG does', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5)
    // Beacon's amber on white: the reason the light themes need another.
    expect(contrast('#F5A94E', '#FFFFFF')).toBeLessThan(2.2)
  })

  it('mixes two colours by the given share', () => {
    expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000')
    expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF')
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080')
  })

  it('calls a background dark below mid grey by eye, not by number', () => {
    expect(isDarkColor('#12141C')).toBe(true)
    // Both well under half by luminance; only the first reads as dark.
    expect(isDarkColor('#666666')).toBe(true)
    expect(isDarkColor('#8A8A8A')).toBe(false)
    expect(isDarkColor('#F6F2EA')).toBe(false)
  })

  it('moves an accent just far enough to reach the contrast it needs', () => {
    const lifted = towardsContrast('#9E5800', '#12141C', 4.5)
    expect(contrast(lifted, '#12141C')).toBeGreaterThanOrEqual(4.5)

    const darkened = towardsContrast('#F5A94E', '#FFFFFF', 4.5)
    expect(contrast(darkened, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    // Darkened, not swapped for black.
    expect(darkened).not.toBe('#000000')
  })

  it('leaves an accent alone that already reads', () => {
    expect(towardsContrast('#F5A94E', '#12141C', 4.5)).toBe('#F5A94E')
  })

  it('accepts only six-digit hex colours', () => {
    expect(isHexColor('#a1B2c3')).toBe(true)
    expect(isHexColor('#abc')).toBe(false)
    expect(isHexColor('#a1b2c3ff')).toBe(false)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor(null)).toBe(false)
  })

  it('converts to and from the canvas components triplets', () => {
    expect(hexToTriplet('#F5A94E')).toBe('245, 169, 78')
    expect(tripletToHex('245, 169, 78')).toBe('#F5A94E')
  })
})
