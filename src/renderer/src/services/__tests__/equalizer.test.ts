import { describe, expect, it } from 'vitest'
import {
  EQ_FREQUENCIES,
  EQ_PRESETS,
  EQ_Q,
  headroomDb,
  isActive,
  presetOf,
  responseDb,
  sanitizeFilters,
  sanitizePresets,
  smoothPath,
  sanitizeSetting,
  toBands,
} from '../equalizer'

const band = (frequency: number, gain: number) => ({ frequency, gain, q: EQ_Q })

// The same profile connect/tests/test_equalizer.py's PROFILE is.
const PROFILE = [
  { frequency: 105, gain: 6.5, q: 0.7, type: 'lowshelf' as const },
  { frequency: 180, gain: -3.2, q: 0.6 },
  { frequency: 2900, gain: 4.1, q: 2.2 },
  { frequency: 10000, gain: -2.5, q: 0.7, type: 'highshelf' as const },
]

describe('equalizer', () => {
  describe('sanitizeSetting', () => {
    it('gives a flat, switched-off setting for nothing stored', () => {
      expect(sanitizeSetting(null)).toEqual({
        enabled: false,
        gains: EQ_FREQUENCIES.map(() => 0),
      })
    })

    it('keeps a profile that is whole, and drops one that is not', () => {
      const profile = { name: 'HD 600', filters: PROFILE }
      expect(sanitizeSetting({ enabled: true, profile }).profile).toEqual(profile)
      expect(sanitizeSetting({ profile: { name: '', filters: PROFILE } }).profile).toBeUndefined()
      expect(sanitizeSetting({ profile: { name: 'x', filters: [] } }).profile).toBeUndefined()
    })

    it('brings a value from another build or a hand edit back into shape', () => {
      const setting = sanitizeSetting({ enabled: 'yes', gains: [40, -40, 2.6, 'x', null] })
      expect(setting.enabled).toBe(false)
      expect(setting.gains).toEqual([12, -12, 3, 0, 0, 0, 0, 0, 0, 0])
    })
  })

  it('counts a curve as active only when it is on and not flat', () => {
    expect(isActive({ enabled: true, gains: [...EQ_PRESETS.bass] })).toBe(true)
    expect(isActive({ enabled: false, gains: [...EQ_PRESETS.bass] })).toBe(false)
    expect(isActive({ enabled: true, gains: [...EQ_PRESETS.flat] })).toBe(false)
  })

  it('counts a profile as active while on, whatever the bands under it', () => {
    const profile = { name: 'HD 600', filters: PROFILE }
    expect(isActive({ enabled: true, gains: [...EQ_PRESETS.flat], profile })).toBe(true)
    expect(isActive({ enabled: false, gains: [...EQ_PRESETS.flat], profile })).toBe(false)
  })

  it('sends a profile in place of the bands', () => {
    const gains = [6, 0, 0, 0, 0, 0, 0, 0, -3, 0]
    const profile = { name: 'HD 600', filters: PROFILE }
    expect(toBands({ enabled: true, gains, profile })).toEqual(PROFILE)
  })

  describe('sanitizeFilters', () => {
    it("holds each filter to connect's bounds", () => {
      expect(
        sanitizeFilters([
          { frequency: 10, gain: 30, q: 50 },
          { frequency: 30000, gain: -30, q: 0.01, type: 'highshelf' },
        ]),
      ).toEqual([
        { frequency: 20, gain: 20, q: 10 },
        { frequency: 20000, gain: -20, q: 0.1, type: 'highshelf' },
      ])
    })

    it('drops a flat filter, one with a type it does not know, and anything malformed', () => {
      expect(
        sanitizeFilters([
          { frequency: 100, gain: 0, q: 1 },
          { frequency: 100, gain: 3, q: 1, type: 'lowpass' },
          { frequency: 'x', gain: 3, q: 1 },
          { frequency: 100, gain: 3 },
          null,
          { frequency: 100, gain: 3, q: 1 },
        ]),
      ).toEqual([{ frequency: 100, gain: 3, q: 1 }])
    })
  })

  it('recognises a preset, and a moved band as none', () => {
    expect(presetOf([...EQ_PRESETS.vocal])).toBe('vocal')
    const moved = [...EQ_PRESETS.vocal]
    moved[0] = 5
    expect(presetOf(moved)).toBeNull()
  })

  it('sends connect only the bands that do something, and nothing when off', () => {
    const gains = [6, 0, 0, 0, 0, 0, 0, 0, -3, 0]
    expect(toBands({ enabled: true, gains, profile: null })).toEqual([band(31, 6), band(8000, -3)])
    expect(toBands({ enabled: false, gains })).toEqual([])
  })

  describe('the response', () => {
    it('reaches a band its own gain at its centre', () => {
      expect(responseDb([band(1000, 6)], 1000)).toBeCloseTo(6, 5)
    })

    it('needs no headroom for a curve that only cuts', () => {
      expect(headroomDb([band(62, -6), band(8000, -3)])).toBe(0)
      expect(headroomDb([])).toBe(0)
    })

    // The numbers connect/core/equalizer.py works out for the same curves -
    // the two have to agree, or a speaker plays a curve at a different
    // level than the dialog draws it.
    it('agrees with connect on the headroom', () => {
      expect(headroomDb([band(1000, 6), band(2000, 6)])).toBeCloseTo(7.1749, 3)
      expect(
        headroomDb(toBands({ enabled: true, gains: [...EQ_PRESETS.smallSpeaker] })),
      ).toBeCloseTo(3.6259, 3)
    })

    it("agrees with connect on a profile's shelves", () => {
      expect(headroomDb(PROFILE)).toBeCloseTo(6.3749, 3)
      expect(responseDb(PROFILE, 50)).toBeCloseTo(5.4809, 3)
      expect(responseDb(PROFILE, 12000)).toBeCloseTo(-1.8093, 3)
    })

    it('agrees with connect on the curve between the bands', () => {
      const bands = toBands({ enabled: true, gains: [...EQ_PRESETS.smallSpeaker] })
      expect(responseDb(bands, 700)).toBeCloseTo(0.8119, 3)
    })
  })

  describe('sanitizePresets', () => {
    it('keeps named presets with whole-step gains inside the range', () => {
      expect(sanitizePresets([{ name: ' Mine ', gains: [20, 1.4, 'x'] }])).toEqual([
        { name: 'Mine', gains: [12, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
      ])
    })

    it('drops what has no name, and keeps the later of two with the same one', () => {
      expect(
        sanitizePresets([
          { name: 'A', gains: [1] },
          { name: '', gains: [2] },
          null,
          { gains: [3] },
          { name: 'A', gains: [4] },
        ]).map((p) => [p.name, p.gains[0]]),
      ).toEqual([['A', 4]])
    })

    it('reads anything that is not a list as none', () => {
      expect(sanitizePresets({ name: 'A' })).toEqual([])
      expect(sanitizePresets(null)).toEqual([])
    })
  })

  describe('smoothPath', () => {
    /** [start, control 1, control 2, end] y values of each curve segment. */
    function segments(path: string): number[][] {
      const numbers = (part: string) => part.match(/-?[\d.]+/g)!.map(Number)
      const [head, ...curves] = path.split('C')
      let previous = numbers(head!).at(-1)!
      return curves.map((curve) => {
        const [, c1, , c2, , end] = numbers(curve)
        const segment = [previous, c1!, c2!, end!]
        previous = end!
        return segment
      })
    }

    const points: [number, number][] = [
      [10, 50],
      [20, 20],
      [30, 20],
      [40, 80],
      [50, 60],
    ]

    it('goes through every point, flat out to both edges', () => {
      const path = smoothPath(points, 100)
      expect(path.startsWith('M0,50.0L10.0,50.0')).toBe(true)
      expect(path.endsWith('L100.0,60.0')).toBe(true)
      expect(segments(path).map((s) => s[3])).toEqual([20, 20, 80, 60])
    })

    it('never swings past the two points it joins', () => {
      // A Bezier stays inside its control points, so controls between the
      // two ends mean no dip and no bulge in between.
      // The second set falls all the way, so its slopes are not just the
      // level ones at each turn.
      const falling: [number, number][] = [
        [10, 80],
        [20, 60],
        [30, 50],
        [40, 10],
        [50, 0],
      ]
      const all = [...segments(smoothPath(points, 100)), ...segments(smoothPath(falling, 100))]
      for (const [start, c1, c2, end] of all) {
        const [low, high] = [Math.min(start!, end!), Math.max(start!, end!)]
        for (const c of [c1!, c2!]) {
          expect(c).toBeGreaterThanOrEqual(low)
          expect(c).toBeLessThanOrEqual(high)
        }
      }
    })

    it('joins two equal points with a straight line', () => {
      expect(segments(smoothPath(points, 100))[1]).toEqual([20, 20, 20, 20])
    })
  })
})
