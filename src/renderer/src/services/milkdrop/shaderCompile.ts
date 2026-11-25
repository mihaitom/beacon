import type { MilkdropPreset, MilkdropVisualizer, PresetShaders, ShaderSources } from 'butterchurn'

/** Compiles a preset's shaders without holding up the page.
 *
 * Butterchurn compiles and links in one go and asks for the uniforms right
 * after, which makes the browser wait for the finished program - on the
 * JS thread and in the GPU process, which draws the whole window. A big
 * shader on Windows (ANGLE hands it to Direct3D's compiler, which unrolls
 * every loop) took long enough there to freeze the browser outright.
 * KHR_parallel_shader_compile lets the driver work on it in the background
 * while COMPLETION_STATUS_KHR is asked, which never waits; the programs it
 * ends up with go to Butterchurn's (patched) loadPreset ready-made. */

interface ParallelCompile {
  COMPLETION_STATUS_KHR: number
}

/** The part of Butterchurn's renderer this reads, as textures.ts does. */
interface RendererInternals {
  renderer?: { gl?: WebGL2RenderingContext }
}

// Asking costs nothing, but there is no event for "done".
const POLL_MS = 30
// Linked programs kept per context, so a preset shown before comes back
// without compiling - the heaviest takes half a minute on a laptop. Kept
// for as long as the context lives (parking.ts keeps it past Now Playing),
// with no limit: each preset is in here once, and the presets are a
// fixed set.
const kept = new WeakMap<WebGL2RenderingContext, Map<string, PresetShaders<WebGLProgram>>>()

function keptFor(gl: WebGL2RenderingContext): Map<string, PresetShaders<WebGLProgram>> {
  let programs = kept.get(gl)
  if (!programs) {
    programs = new Map()
    kept.set(gl, programs)
  }
  return programs
}

function sourceKey(sources: { warp: ShaderSources; comp: ShaderSources }): string {
  return [sources.warp.vert, sources.warp.frag, sources.comp.vert, sources.comp.frag].join('\0')
}

interface Pending {
  program: WebGLProgram
  shaders: WebGLShader[]
}

function startLink(gl: WebGL2RenderingContext, sources: ShaderSources): Pending | null {
  const program = gl.createProgram()
  const vert = gl.createShader(gl.VERTEX_SHADER)
  const frag = gl.createShader(gl.FRAGMENT_SHADER)
  if (!program || !vert || !frag) return null
  gl.shaderSource(vert, sources.vert)
  gl.shaderSource(frag, sources.frag)
  gl.compileShader(vert)
  gl.compileShader(frag)
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  return { program, shaders: [vert, frag] }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/** The preset's warp and comp programs, linked - or null where the
 * browser cannot compile in the background, and Butterchurn has to do it
 * the old way. A preset compiled before on this context comes back at
 * once. Rejects when a shader does not compile, the context is
 * lost, or `signal` calls it off; whatever was made by then is deleted. */
export async function compilePresetShaders(
  visualizer: MilkdropVisualizer,
  preset: MilkdropPreset,
  signal: AbortSignal,
): Promise<PresetShaders<WebGLProgram> | null> {
  const gl = (visualizer as unknown as RendererInternals).renderer?.gl
  const parallel = gl?.getExtension('KHR_parallel_shader_compile') as ParallelCompile | null
  if (!gl || !parallel) return null
  const sources = visualizer.shaderSources(preset)
  const key = sourceKey(sources)
  const programs = keptFor(gl)
  if (gl.isContextLost()) programs.clear()
  const hit = programs.get(key)
  if (hit) return hit
  const warp = startLink(gl, sources.warp)
  const comp = startLink(gl, sources.comp)
  const pending = [warp, comp].filter((entry): entry is Pending => entry !== null)
  let done = false
  try {
    if (!warp || !comp) throw new Error('Could not create a shader program')
    for (;;) {
      signal.throwIfAborted()
      if (gl.isContextLost()) throw new Error('WebGL context lost while compiling')
      const ready = pending.every((entry) =>
        gl.getProgramParameter(entry.program, parallel.COMPLETION_STATUS_KHR),
      )
      if (ready) break
      await wait(POLL_MS, signal)
    }
    for (const entry of pending) {
      if (!gl.getProgramParameter(entry.program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(entry.program) || 'Shader did not link')
      }
    }
    done = true
    const linked = { warp: warp.program, comp: comp.program }
    programs.set(key, linked)
    return linked
  } finally {
    for (const entry of pending) {
      // A linked program keeps working without its shaders.
      for (const shader of entry.shaders) gl.deleteShader(shader)
      if (!done) gl.deleteProgram(entry.program)
    }
  }
}
