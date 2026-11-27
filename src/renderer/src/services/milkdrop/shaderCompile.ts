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

/** Deleting a program, or reading its status, before the driver is done
 * with it makes the GPU process wait for the compile to finish - the same
 * freeze as compiling in the foreground. So a compile nobody waits for any
 * more runs to its end all the same, and goes into `kept` for next time. */
const compiling = new WeakMap<
  WebGL2RenderingContext,
  Map<string, Promise<PresetShaders<WebGLProgram>>>
>()

function compilingFor(
  gl: WebGL2RenderingContext,
): Map<string, Promise<PresetShaders<WebGLProgram>>> {
  let running = compiling.get(gl)
  if (!running) {
    running = new Map()
    compiling.set(gl, running)
  }
  return running
}

async function link(
  gl: WebGL2RenderingContext,
  parallel: ParallelCompile,
  sources: { warp: ShaderSources; comp: ShaderSources },
): Promise<PresetShaders<WebGLProgram>> {
  const warp = startLink(gl, sources.warp)
  const comp = startLink(gl, sources.comp)
  const pending = [warp, comp].filter((entry): entry is Pending => entry !== null)
  let done = false
  try {
    if (!warp || !comp) throw new Error('Could not create a shader program')
    for (;;) {
      if (gl.isContextLost()) throw new Error('WebGL context lost while compiling')
      const ready = pending.every((entry) =>
        gl.getProgramParameter(entry.program, parallel.COMPLETION_STATUS_KHR),
      )
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    for (const entry of pending) {
      if (!gl.getProgramParameter(entry.program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(entry.program) || 'Shader did not link')
      }
    }
    done = true
    return { warp: warp.program, comp: comp.program }
  } finally {
    // Only reached once the driver is done, or the context is gone.
    for (const entry of pending) {
      // A linked program keeps working without its shaders.
      for (const shader of entry.shaders) gl.deleteShader(shader)
      if (!done) gl.deleteProgram(entry.program)
    }
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** The preset's warp and comp programs, linked - or null where the
 * browser cannot compile in the background, and Butterchurn has to do it
 * the old way. A preset compiled before on this context comes back at
 * once, one still compiling is waited for rather than started again.
 * Rejects when a shader does not compile, the context is lost, or
 * `signal` calls it off - which stops the waiting, not the compile. */
export async function compilePresetShaders(
  visualizer: MilkdropVisualizer,
  preset: MilkdropPreset,
  signal: AbortSignal,
): Promise<PresetShaders<WebGLProgram> | null> {
  const gl = (visualizer as unknown as RendererInternals).renderer?.gl
  const parallel = gl?.getExtension('KHR_parallel_shader_compile') as ParallelCompile | null
  if (!gl || !parallel) return null
  signal.throwIfAborted()
  const sources = visualizer.shaderSources(preset)
  const key = sourceKey(sources)
  const programs = keptFor(gl)
  if (gl.isContextLost()) programs.clear()
  const hit = programs.get(key)
  if (hit) return hit
  const running = compilingFor(gl)
  let work = running.get(key)
  if (!work) {
    work = link(gl, parallel, sources)
    running.set(key, work)
    work
      .then(
        (linked) => programs.set(key, linked),
        () => {},
      )
      .finally(() => running.delete(key))
  }
  return untilAborted(work, signal)
}
