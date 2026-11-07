import { describe, expect, it } from 'vitest'
import {
  EQ_FREQUENCIES,
  EQ_PRESETS,
  EQ_Q,
  headroomDb,
  isActive,
  presetOf,
  responseDb,
  sanitizeSetting,
  toBands,
} from '../equalizer'

const band = (frequency: number, gain: number) => ({ frequency, gain, q: EQ_Q })

describe('equalizer', () => {
  describe('sanitizeSetting', () => {
    it('gives a flat, switched-off setting for nothing stored', () => {
      expect(sanitizeSetting(null)).toEqual({
        enabled: false,
        gains: EQ_FREQUENCIES.map(() => 0),
      })
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

  it('recognises a preset, and a moved band as none', () => {
    expect(presetOf([...EQ_PRESETS.vocal])).toBe('vocal')
    const moved = [...EQ_PRESETS.vocal]
    moved[0] = 5
    expect(presetOf(moved)).toBeNull()
  })

  it('sends connect only the bands that do something, and nothing when off', () => {
    const gains = [6, 0, 0, 0, 0, 0, 0, 0, -3, 0]
    expect(toBands({ enabled: true, gains })).toEqual([band(31, 6), band(8000, -3)])
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

    it('agrees with connect on the curve between the bands', () => {
      const bands = toBands({ enabled: true, gains: [...EQ_PRESETS.smallSpeaker] })
      expect(responseDb(bands, 700)).toBeCloseTo(0.8119, 3)
    })
  })
})
