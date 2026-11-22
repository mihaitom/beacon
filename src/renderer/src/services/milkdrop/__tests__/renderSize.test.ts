import { describe, expect, it } from 'vitest'
import { MAX_RENDER_EDGE, renderSize } from '../renderSize'

describe('renderSize', () => {
  it("draws in the screen's own pixels", () => {
    expect(renderSize(1000, 500, 1)).toEqual({ width: 1000, height: 500 })
    expect(renderSize(1000, 500, 1.5)).toEqual({ width: 1500, height: 750 })
  })

  it('scales a picture past the limit down, keeping its shape', () => {
    expect(renderSize(1920, 1080, 2)).toEqual({ width: MAX_RENDER_EDGE, height: 1440 })
    expect(renderSize(500, 3000, 1)).toEqual({ width: 427, height: MAX_RENDER_EDGE })
  })

  it('never goes below one pixel, nor trusts a ratio that is no ratio', () => {
    expect(renderSize(0, 0, 1)).toEqual({ width: 1, height: 1 })
    expect(renderSize(800, 600, Number.NaN)).toEqual({ width: 800, height: 600 })
    expect(renderSize(800, 600, 0)).toEqual({ width: 800, height: 600 })
  })
})
