// The preview's rotation has to match connect's (lights/controller.py's
// rotation()), or the dialog shows colours the lights never take.
import { describe, expect, it } from 'vitest'
import { hexToRgb, previewTurn, rgbToHex, rotation } from '../stagePreview'

describe('rotation', () => {
  it('starts at the picture colour, the others evenly round the wheel', () => {
    expect(rotation([255, 0, 0], 3, 0).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('turns by the given share of the wheel', () => {
    expect(rotation([255, 0, 0], 3, 1 / 3).map(rgbToHex)).toEqual(['#00ff00', '#0000ff', '#ff0000'])
    expect(rotation([255, 0, 0], 3, 1).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })
})

describe('previewTurn', () => {
  it('moves on with the beats and stands still through the breakdown', () => {
    // 120 BPM: a beat every half second; beats 24-31 of every 32 are the
    // breakdown.
    expect(previewTurn(0.1)).toBe(0)
    expect(previewTurn(5.1)).toBeGreaterThan(previewTurn(4.1))
    expect(previewTurn(15.9)).toBe(previewTurn(12.1))
    expect(previewTurn(16.1)).toBeGreaterThan(previewTurn(15.9))
  })

  it('takes only the hue of the start colour', () => {
    expect(rgbToHex(rotation(hexToRgb('#802020'), 1, 0)[0]!)).toBe('#ff0000')
  })
})
