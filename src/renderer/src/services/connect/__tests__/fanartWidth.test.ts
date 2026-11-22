import { afterEach, describe, expect, it, vi } from 'vitest'
import { fanartImageWidth } from '../fanartWidth'

function screenOf(width: number, height: number, dpr: number): void {
  vi.stubGlobal('screen', { width, height })
  vi.stubGlobal('devicePixelRatio', dpr)
}

describe('fanartImageWidth', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rounds the long side in device pixels up to the next step', () => {
    screenOf(1920, 1080, 1)
    expect(fanartImageWidth()).toBe(1920)
    screenOf(1440, 900, 1)
    expect(fanartImageWidth()).toBe(1920)
  })

  it('takes the long side whichever way round the screen is held', () => {
    screenOf(390, 844, 3)
    expect(fanartImageWidth()).toBe(2560)
  })

  it('asks for the full image on a screen larger than every step', () => {
    screenOf(3840, 2160, 1)
    expect(fanartImageWidth()).toBeNull()
  })

  it('never asks a phone to load the full image', () => {
    screenOf(412, 915, 3.5)
    expect(fanartImageWidth()).toBe(2560)
  })
})
