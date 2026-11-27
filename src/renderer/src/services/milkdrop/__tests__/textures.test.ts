import { describe, expect, it } from 'vitest'
import { shippedPicturesFor, withAccent } from '../textures'

const TAKES_ACCENT = {
  baseVals: { wave_r: 1, wave_g: 1, wave_b: 1, zoom: 1.01 },
  comp: 'uniform sampler2D sampler_accent;\n shader_body { ret = vec3(0.0); }',
}

describe('withAccent', () => {
  it('draws the waveform of a preset that takes the accent in it', () => {
    const result = withAccent(TAKES_ACCENT, '255, 0, 51')
    expect(result.baseVals).toEqual({ wave_r: 1, wave_g: 0, wave_b: 0.2, zoom: 1.01 })
    expect(TAKES_ACCENT.baseVals.wave_g).toBe(1)
  })

  it('leaves every other preset as it is', () => {
    const other = { baseVals: { wave_r: 1 }, comp: 'shader_body { ret = vec3(0.0); }' }
    expect(withAccent(other, '255, 0, 0')).toBe(other)
  })

  it('leaves a preset that draws no waveform alone, so a new accent does not restart it', () => {
    const noWave = { ...TAKES_ACCENT, baseVals: { ...TAKES_ACCENT.baseVals, wave_a: 0 } }
    expect(withAccent(noWave, '255, 0, 51')).toBe(noWave)
  })

  it('still colours a waveform its equations turn up', () => {
    const later = {
      ...TAKES_ACCENT,
      baseVals: { ...TAKES_ACCENT.baseVals, wave_a: 0 },
      frame_eqs_str: 'a.wave_a=a.bass;',
    }
    expect(withAccent(later, '255, 0, 51')).not.toBe(later)
  })

  it('leaves the preset alone for an accent it cannot read', () => {
    expect(withAccent(TAKES_ACCENT, 'amber')).toBe(TAKES_ACCENT)
  })
})

describe('shippedPicturesFor', () => {
  it("names the shipped pictures a preset's shaders read, and only those", () => {
    expect(shippedPicturesFor({ warp: 'uniform sampler2D sampler_moon;', comp: '' })).toEqual([
      'moon',
    ])
    expect(shippedPicturesFor({ warp: 'uniform sampler2D sampler_moonlight;', comp: '' })).toEqual(
      [],
    )
    expect(shippedPicturesFor(TAKES_ACCENT)).toEqual([])
  })
})
