// The cover and the accent reach the presets through Butterchurn's
// internals (see textures.ts), which only a real WebGL context can show: a
// version that moved them would leave Beacon's presets on a stand-in
// picture without a single error.
import { describe, expect, it } from 'vitest'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { loadShippedPicture, setDataTexture, setTexture } from '../textures'

const SIZE = 64

// Draws nothing but the cover, straight onto the screen.
const COVER_ONLY = {
  baseVals: { decay: 1, wave_a: 0, mv_a: 0, ob_size: 0, ib_size: 0 },
  shapes: [],
  waves: [],
  init_eqs_str: '',
  frame_eqs_str: '',
  pixel_eqs_str: '',
  warp: 'shader_body { ret = texture(sampler_main, uv).rgb; }',
  comp: 'uniform sampler2D sampler_cover;\n shader_body { ret = texture(sampler_cover, uv).rgb; }',
}

function solid(colour: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const context = canvas.getContext('2d')!
  context.fillStyle = colour
  context.fillRect(0, 0, 32, 32)
  return canvas
}

function centre(
  canvas: HTMLCanvasElement,
  visualizer: { render(): void },
): [number, number, number] {
  visualizer.render()
  const gl = canvas.getContext('webgl2')!
  const pixel = new Uint8Array(4)
  gl.readPixels(SIZE / 2, SIZE / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  return [pixel[0]!, pixel[1]!, pixel[2]!]
}

describe('setTexture', () => {
  it('puts the cover where the presets read it, and replaces it with the next', () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const visualizer = butterchurn.createVisualizer(new OfflineAudioContext(2, 1, 44100), canvas, {
      width: SIZE,
      height: SIZE,
      pixelRatio: 1,
    })
    visualizer.loadPreset(COVER_ONLY, 0)

    expect(setTexture(visualizer, 'cover', solid('#ff0000'))).toBe(true)
    const [r, g, b] = centre(canvas, visualizer)
    expect(r).toBeGreaterThan(200)
    expect(g + b).toBeLessThan(40)

    setTexture(visualizer, 'cover', solid('#0000ff'))
    const [r2, , b2] = centre(canvas, visualizer)
    expect(b2).toBeGreaterThan(200)
    expect(r2).toBeLessThan(40)
  })
})

// Shows the data texture's second texel, red from x and green from y.
const DATA_ONLY = {
  ...COVER_ONLY,
  comp: 'uniform sampler2D sampler_orbit;\n shader_body { ret = vec3(texelFetch(sampler_orbit, ivec2(1, 0), 0).xy, 0.0); }',
}

describe('setDataTexture', () => {
  it('hands a preset the numbers unfiltered, texel by texel', () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const visualizer = butterchurn.createVisualizer(new OfflineAudioContext(2, 1, 44100), canvas, {
      width: SIZE,
      height: SIZE,
      pixelRatio: 1,
    })
    visualizer.loadPreset(DATA_ONLY, 0)

    const data = new Float32Array([0, 0, 0, 0, 0.75, 0.25, 1, 0, 0, 0, 0, 0])
    expect(setDataTexture(visualizer, 'orbit', data, 3, 1)).toBe(true)
    const [r, g] = centre(canvas, visualizer)
    expect(r).toBeGreaterThan(185)
    expect(r).toBeLessThan(197)
    expect(g).toBeGreaterThan(58)
    expect(g).toBeLessThan(70)
  })
})

describe('loadShippedPicture', () => {
  it('decodes a picture that ships with Beacon', async () => {
    const moon = await loadShippedPicture('moon')
    expect(moon.width).toBeGreaterThan(0)
    expect(moon.height).toBeGreaterThan(0)
  })
})
