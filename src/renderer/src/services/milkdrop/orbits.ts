/** Zooming far into the Mandelbrot set needs more digits than the GPU's
 * floats hold: past about 2^-13 neighbouring pixels land on the same
 * number. A preset that goes deeper names its targets as long decimals;
 * their orbits (z -> z^2 + c, from 0) are worked out here with exact
 * integers, and its shader follows only each pixel's small difference from
 * one (perturbation), which a float does hold - its exponent reaches
 * 2^-126 even where its digits run out. */

export const ORBIT_SAMPLER = 'orbit'

/** Entries kept per orbit. Not a limit on the iterations: a shader that
 * runs out starts over from the first entry (rebasing). WebGL 2 promises
 * textures this wide. */
export const ORBIT_LENGTH = 2048

// Far beyond the deepest zoom's 2^-110 per pixel, with room for the
// error that each step of an orbit doubles at most.
const FRACTION_BITS = 320n
const ESCAPE_RADIUS_SQUARED = 4

/** A preset's target: the real and imaginary part, as decimals. */
export type OrbitTarget = readonly [string, string]

function toFixed(decimal: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(decimal.trim())
  if (!match) throw new Error(`Not a decimal: ${decimal}`)
  const fraction = match[3] ?? ''
  const value = (BigInt(match[2]! + fraction) << FRACTION_BITS) / 10n ** BigInt(fraction.length)
  return match[1] ? -value : value
}

function toFloat(value: bigint): number {
  return Number(value >> (FRACTION_BITS - 64n)) / 2 ** 64
}

/** One row per target, ORBIT_LENGTH texels each: x and y the orbit's
 * point, z 1 while there is a next point to step to - 0 where the orbit
 * escaped or the row ends, which is where the shader starts over. */
export function referenceOrbits(targets: readonly OrbitTarget[]): Float32Array {
  const data = new Float32Array(ORBIT_LENGTH * targets.length * 4)
  targets.forEach(([re, im], row) => {
    const cr = toFixed(re)
    const ci = toFixed(im)
    let zr = 0n
    let zi = 0n
    for (let n = 0; n < ORBIT_LENGTH; n++) {
      const at = (row * ORBIT_LENGTH + n) * 4
      const x = toFloat(zr)
      const y = toFloat(zi)
      data[at] = x
      data[at + 1] = y
      if (x * x + y * y > ESCAPE_RADIUS_SQUARED || n === ORBIT_LENGTH - 1) break
      data[at + 2] = 1
      const next = ((zr * zr - zi * zi) >> FRACTION_BITS) + cr
      zi = ((2n * zr * zi) >> FRACTION_BITS) + ci
      zr = next
    }
  })
  return data
}

// A preset's file is loaded once and kept, so its targets are worked out
// once too.
const computed = new WeakMap<readonly OrbitTarget[], Float32Array>()

export function orbitsFor(targets: readonly OrbitTarget[]): Float32Array {
  let data = computed.get(targets)
  if (!data) {
    data = referenceOrbits(targets)
    computed.set(targets, data)
  }
  return data
}
