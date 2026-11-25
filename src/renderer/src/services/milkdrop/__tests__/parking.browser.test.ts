// What parking is for: a context that comes back still has what it
// compiled, and only one is ever held. Real WebGL, since a stand-in would
// say nothing about whether a detached, shrunken canvas keeps its programs.
import { afterEach, describe, expect, it } from 'vitest'
import type { MilkdropPreset } from 'butterchurn'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { compilePresetShaders } from '../shaderCompile'
import { park, unpark } from '../parking'

const SIZE = 64
const COMPLETION_STATUS_KHR = 0x91b1

const preset: MilkdropPreset = {
  baseVals: { decay: 1, wave_a: 0, mv_a: 0, ob_size: 0, ib_size: 0 },
  shapes: [],
  waves: [],
  init_eqs_str: '',
  frame_eqs_str: '',
  pixel_eqs_str: '',
  warp: 'shader_body { ret = texture(sampler_main, uv).rgb; }',
  comp: 'shader_body { ret = vec3(0.0, 1.0, 0.0); }',
}

// Headless Chromium has no KHR_parallel_shader_compile; see
// shaderCompile.browser.test.ts.
function make() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  document.body.appendChild(canvas)
  const audio = new OfflineAudioContext(2, 1, 44100)
  const visualizer = butterchurn.createVisualizer(audio, canvas, {
    width: SIZE,
    height: SIZE,
    pixelRatio: 1,
  })
  const gl = canvas.getContext('webgl2')!
  const extension = gl.getExtension.bind(gl)
  const parameter = gl.getProgramParameter.bind(gl)
  gl.getExtension = ((name: string) =>
    name === 'KHR_parallel_shader_compile'
      ? { COMPLETION_STATUS_KHR }
      : extension(name)) as typeof gl.getExtension
  gl.getProgramParameter = (program, pname) =>
    pname === COMPLETION_STATUS_KHR ? true : parameter(program, pname)
  return { canvas, audio, visualizer, gl }
}

afterEach(() => {
  unpark(null)
})

describe('parking', () => {
  it('brings a context back with the presets it compiled, still drawing', async () => {
    const { canvas, audio, visualizer, gl } = make()
    const signal = new AbortController().signal
    const programs = await compilePresetShaders(visualizer, preset, signal)
    canvas.remove()
    park({ canvas, visualizer, audio })

    const back = unpark(audio)
    expect(back?.visualizer).toBe(visualizer)
    let linked = 0
    const link = gl.linkProgram.bind(gl)
    gl.linkProgram = (program) => {
      linked++
      link(program)
    }
    expect(await compilePresetShaders(visualizer, preset, signal)).toBe(programs)
    expect(linked).toBe(0)

    canvas.width = canvas.height = SIZE
    visualizer.setRendererSize(SIZE, SIZE, { pixelRatio: 1 })
    visualizer.loadPreset(preset, 0, programs)
    visualizer.render()
    const pixel = new Uint8Array(4)
    gl.readPixels(SIZE / 2, SIZE / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    expect(pixel[1]).toBeGreaterThan(200)
  })

  it('holds one context at most', () => {
    const first = make()
    const second = make()
    park(first)
    park(second)
    expect(first.gl.isContextLost()).toBe(true)
    expect(unpark(null)?.visualizer).toBe(second.visualizer)
  })

  it('lets go of one made with an audio context that cannot be connected', () => {
    const parked = make()
    park(parked)
    expect(unpark(new OfflineAudioContext(2, 1, 44100))).toBeNull()
    expect(parked.gl.isContextLost()).toBe(true)
  })
})
