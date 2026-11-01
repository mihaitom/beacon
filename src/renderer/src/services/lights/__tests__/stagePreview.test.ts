// The preview's rotation has to match connect's (lights/controller.py's
// rotation()), or the dialog shows colours the lights never take.
import { describe, expect, it } from 'vitest'
import { hexToRgb, rgbToHex, rotation } from '../stagePreview'

describe('rotation', () => {
  it('starts at the picture colour, the others evenly round the wheel', () => {
    expect(rotation([255, 0, 0], 3, 0).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('turns once every 30 seconds', () => {
    expect(rotation([255, 0, 0], 3, 10).map(rgbToHex)).toEqual(['#00ff00', '#0000ff', '#ff0000'])
    expect(rotation([255, 0, 0], 3, 30).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('takes only the hue of the start colour', () => {
    expect(rgbToHex(rotation(hexToRgb('#802020'), 1, 0)[0]!)).toBe('#ff0000')
  })
})
