// The compile-ahead path hands Butterchurn programs it did not make
// (patches/butterchurn@2.6.7.patch). Only a real WebGL context shows that
// they are the ones it draws with - a version that ignored them would
// compile again, in the foreground, without a single error.
//
// Headless Chromium draws in software, which does not offer
// KHR_parallel_shader_compile; it is stood in for here (every program
// reports itself finished), so the compiling itself is real but not in the
// background.
import { describe, expect, it } from 'vitest'
import type { MilkdropPreset } from 'butterchurn'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import { loadPresetFile } from '../presets'
import { compilePresetShaders } from '../shaderCompile'
import { keepLoopsRolled } from '../loops'

const SIZE = 64

function solidPreset(rgb: string): MilkdropPreset {
  return {
    baseVals: { decay: 1, wave_a: 0, mv_a: 0, ob_size: 0, ib_size: 0 },
    shapes: [],
    waves: [],
    init_eqs_str: '',
    frame_eqs_str: '',
    pixel_eqs_str: '',
    warp: 'shader_body { ret = texture(sampler_main, uv).rgb; }',
    comp: `shader_body { ret = vec3(${rgb}); }`,
  }
}

const COMPLETION_STATUS_KHR = 0x91b1

function standInParallelCompile(gl: WebGL2RenderingContext): void {
  const extension = gl.getExtension.bind(gl)
  const parameter = gl.getProgramParameter.bind(gl)
  gl.getExtension = ((name: string) =>
    name === 'KHR_parallel_shader_compile'
      ? { COMPLETION_STATUS_KHR }
      : extension(name)) as typeof gl.getExtension
  gl.getProgramParameter = (program, pname) =>
    pname === COMPLETION_STATUS_KHR ? true : parameter(program, pname)
}

function setup(withParallel = true) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const visualizer = butterchurn.createVisualizer(new OfflineAudioContext(2, 1, 44100), canvas, {
    width: SIZE,
    height: SIZE,
    pixelRatio: 1,
  })
  const gl = canvas.getContext('webgl2')!
  if (withParallel) standInParallelCompile(gl)
  const centre = (): [number, number, number] => {
    visualizer.render()
    const pixel = new Uint8Array(4)
    gl.readPixels(SIZE / 2, SIZE / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [pixel[0]!, pixel[1]!, pixel[2]!]
  }
  return { visualizer, gl, centre }
}

describe('compilePresetShaders', () => {
  it('draws with the programs it compiled ahead', async () => {
    const { visualizer, gl, centre } = setup()
    const preset = solidPreset('0.0, 1.0, 0.0')
    const programs = await compilePresetShaders(visualizer, preset, new AbortController().signal)
    expect(programs).not.toBeNull()
    // Each would fail to draw if Butterchurn had linked its own instead.
    const linked: WebGLProgram[] = []
    const link = gl.linkProgram.bind(gl)
    gl.linkProgram = (program) => {
      linked.push(program)
      link(program)
    }
    visualizer.loadPreset(preset, 0, programs)
    expect(linked).toEqual([])
    const [r, g, b] = centre()
    expect(g).toBeGreaterThan(200)
    expect(r + b).toBeLessThan(40)
  })

  it('makes the same sources Butterchurn compiles itself', () => {
    const { visualizer, gl } = setup()
    const preset = solidPreset('1.0, 0.0, 0.0')
    const sources = visualizer.shaderSources(preset)
    const seen: string[] = []
    const source = gl.shaderSource.bind(gl)
    gl.shaderSource = (shader, text) => {
      seen.push(text)
      source(shader, text)
    }
    visualizer.loadPreset(preset, 0)
    expect(seen).toEqual([
      sources.warp.vert,
      sources.warp.frag,
      sources.comp.vert,
      sources.comp.frag,
    ])
  })

  it('compiles the heaviest shipped preset, its loops kept rolled', async () => {
    const { visualizer } = setup()
    const { preset } = await loadPresetFile('builtin:beacon-milky-way')
    const programs = await compilePresetShaders(
      visualizer,
      keepLoopsRolled(preset),
      new AbortController().signal,
    )
    expect(programs).not.toBeNull()
  })

  it('draws the same picture with its loops kept rolled', () => {
    // Ten steps of 0.1 in red, from 1 in green: both loop starts moved.
    const preset = {
      ...solidPreset('0.0'),
      comp: `shader_body {
        ret = vec3(0.0);
        for (int i = 0; i < 10; i++) ret.r += 0.1;
        for (int k = 1; k <= 3; k++) ret.g += 0.25;
      }`,
    }
    const plain = setup(false)
    plain.visualizer.loadPreset(preset, 0)
    const rolled = setup(false)
    rolled.visualizer.loadPreset(keepLoopsRolled(preset), 0)
    const [r, g] = rolled.centre()
    expect(rolled.centre()).toEqual(plain.centre())
    expect(r).toBeGreaterThan(240)
    expect(g).toBeGreaterThan(180)
  })

  it('rejects a shader that does not compile, and cleans up', async () => {
    const { visualizer, gl } = setup()
    const deleted: WebGLProgram[] = []
    const remove = gl.deleteProgram.bind(gl)
    gl.deleteProgram = (program) => {
      deleted.push(program!)
      remove(program)
    }
    const broken = solidPreset('this is not glsl')
    await expect(
      compilePresetShaders(visualizer, broken, new AbortController().signal),
    ).rejects.toThrow()
    expect(deleted).toHaveLength(2)
  })

  it('leaves the compiling to Butterchurn where the browser cannot do it aside', async () => {
    const { visualizer } = setup(false)
    const programs = await compilePresetShaders(
      visualizer,
      solidPreset('0.0, 0.0, 1.0'),
      new AbortController().signal,
    )
    expect(programs).toBeNull()
  })

  it('stops when called off', async () => {
    const { visualizer } = setup()
    const stop = new AbortController()
    stop.abort()
    await expect(
      compilePresetShaders(visualizer, solidPreset('0.0, 0.0, 1.0'), stop.signal),
    ).rejects.toBeDefined()
  })
})
