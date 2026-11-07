import { describe, expect, it } from 'vitest'
import { ProfileImportError, importProfile, parseProfile, profileName } from '../equalizerImport'

function problemOf(text: string): string {
  try {
    parseProfile(text)
  } catch (error) {
    if (error instanceof ProfileImportError) return error.problem
    throw error
  }
  return 'none'
}

describe('importing a profile', () => {
  it("reads AutoEq's ParametricEQ.txt, leaving its preamp to the headroom", () => {
    const text = [
      'Preamp: -6.4 dB',
      'Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70',
      'Filter 2: ON PK Fc 180 Hz Gain -3.2 dB Q 0.60',
      'Filter 3: ON HSC Fc 10000 Hz Gain -2.5 dB Q 0.70',
    ].join('\r\n')
    expect(parseProfile(text)).toEqual([
      { frequency: 105, gain: 6.5, q: 0.7, type: 'lowshelf' },
      { frequency: 180, gain: -3.2, q: 0.6 },
      { frequency: 10000, gain: -2.5, q: 0.7, type: 'highshelf' },
    ])
  })

  it("reads REW's export: padded, numbered, empty slots and switched-off filters skipped", () => {
    const text = [
      'Filter Settings file',
      'Equaliser: Generic',
      'Filter  1: ON  PK       Fc    63.00 Hz  Gain  -5.00 dB  Q  4.000',
      'Filter  2: OFF PK       Fc   100.0 Hz  Gain   3.00 dB  Q  1.000',
      'Filter  3: ON  None',
      'Filter  4: ON  PEQ      Fc  1000 Hz  Gain   2,5 dB  BW Oct 1.0',
    ].join('\n')
    const filters = parseProfile(text)
    expect(filters).toHaveLength(2)
    expect(filters[0]).toEqual({ frequency: 63, gain: -5, q: 4 })
    // One octave wide is a Q of 1.414.
    expect(filters[1]!.gain).toBe(2.5)
    expect(filters[1]!.q).toBeCloseTo(Math.SQRT2, 3)
  })

  it('ignores comments and a filter line without a number', () => {
    expect(parseProfile('# measured\nFilter: ON PK Fc 500 Hz Gain 2 dB Q 1 # mid')).toEqual([
      { frequency: 500, gain: 2, q: 1 },
    ])
  })

  it('says what is wrong with a file it cannot play', () => {
    expect(problemOf('Preamp: -3 dB')).toBe('empty')
    expect(problemOf('Filter 1: ON PK Fc 100 Hz Gain 0 dB Q 1')).toBe('empty')
    expect(problemOf('Filter 1: ON LP Fc 100 Hz')).toBe('unsupported')
    // A shelf by slope rather than Q has a different shape.
    expect(problemOf('Filter 1: ON LS Fc 100 Hz Gain 3 dB')).toBe('unsupported')
    expect(problemOf('GraphicEQ: 20 -3; 40 -2')).toBe('graphic')
    expect(problemOf('Channel: L\nFilter: ON PK Fc 100 Hz Gain 3 dB Q 1')).toBe('channels')
    expect(problemOf('Channel: all\nFilter: ON PK Fc 100 Hz Gain 3 dB Q 1')).toBe('none')
    const many = Array.from(
      { length: 21 },
      (_, i) => `Filter ${i}: ON PK Fc ${100 + i} Hz Gain 1 dB Q 1`,
    )
    expect(problemOf(many.join('\n'))).toBe('tooMany')
  })

  it('names the unsupported filter type', () => {
    expect(() => parseProfile('Filter 1: ON HP Fc 30 Hz')).toThrow(
      expect.objectContaining({ detail: 'HP' }),
    )
  })

  it("is named after the file, without AutoEq's suffix", () => {
    expect(profileName('Sennheiser HD 600 ParametricEQ.txt')).toBe('Sennheiser HD 600')
    expect(profileName('Sennheiser HD 600 FixedBandEQ.txt')).toBe('Sennheiser HD 600')
    expect(profileName('room.txt')).toBe('room')
    expect(importProfile('a.txt', 'Filter: ON PK Fc 500 Hz Gain 2 dB Q 1').name).toBe('a')
  })
})
