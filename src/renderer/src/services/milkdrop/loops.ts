import type { MilkdropPreset } from 'butterchurn'

/** Keeps the shader compiler from unrolling a preset's loops.
 *
 * On Windows, Chrome and Edge hand WebGL shaders to Direct3D's compiler,
 * which unrolls every loop whose count it can work out - and the functions
 * called inside along with it, so a 200-step march around a noise function
 * with loops of its own becomes thousands of copies. That compile took long
 * enough to hang the browser. A loop starting at a value read from a
 * uniform has no count to work out; `frame` is never negative, so the
 * start is the same 0 (or whatever it was) and the picture does not change.
 * The same trick Shadertoy shaders use for the same reason. */

const ZERO = 'BEACON_ZERO'
const DEFINE = `#define ${ZERO} int(min(frame, 0.0))\n`
const LOOP_START = /for\s*\(\s*int\s+(\w+)\s*=\s*([^;]+);/g

export function keepLoopsRolledIn(shader: string): string {
  if (shader.search(LOOP_START) === -1) return shader
  return (
    DEFINE +
    shader.replace(
      LOOP_START,
      (_, name, start) => `for (int ${name} = (${start.trim()}) + ${ZERO};`,
    )
  )
}

export function keepLoopsRolled(preset: MilkdropPreset): MilkdropPreset {
  const warp = typeof preset.warp === 'string' ? keepLoopsRolledIn(preset.warp) : preset.warp
  const comp = typeof preset.comp === 'string' ? keepLoopsRolledIn(preset.comp) : preset.comp
  if (warp === preset.warp && comp === preset.comp) return preset
  return { ...preset, warp, comp }
}
