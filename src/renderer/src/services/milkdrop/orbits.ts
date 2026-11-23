/** Zooming far into the Mandelbrot set needs more digits than the GPU's
 * floats hold: past about 2^-13 neighbouring pixels land on the same
 * number. A preset that goes deeper names its targets as long decimals;
 * their orbits (z -> z^2 + c from 0, or one of its relatives below) are
 * worked out here with exact integers, and its shader follows only each
 * pixel's small difference from one (perturbation), which a float does
 * hold - its exponent reaches 2^-126 even where its digits run out. */

export const ORBIT_SAMPLER = 'orbit'

/** Entries kept per orbit. Not a limit on the iterations: a shader that
 * runs out starts over from the first entry (rebasing). WebGL 2 promises
 * textures this wide. */
export const ORBIT_LENGTH = 2048

// Far beyond the deepest zoom's 2^-110 per pixel, with room for the
// error that each step of an orbit doubles at most.
const FRACTION_BITS = 320n
const ESCAPE_RADIUS_SQUARED = 4
// A minibrot's own centre comes back near 0 once a period - the shipped
// ones to 2^-167 and below. Its orbit ends there, and the shader starts
// over with d + Z: exact while Z is no larger than the pixels' d (2^-115
// at the deepest). Carrying on would wait for |Z + d| < |d|, which at
// Z ~ 0 rarely holds, and run to the row's end with d out of step - a
// flat picture.
const BACK_AT_ZERO_SQUARED = 2 ** -220

/** The step from z to the next point, c added after:
 * - mandelbrot: z^2
 * - multibrot3, multibrot4: z^3, z^4
 * - tricorn: z's conjugate squared
 * - burning-ship: z^2 with both of z's parts made positive first */
export type OrbitFractal = 'mandelbrot' | 'multibrot3' | 'multibrot4' | 'tricorn' | 'burning-ship'

/** A preset's target: the real and imaginary part, as decimals, and which
 * fractal - the Mandelbrot set unless it says otherwise. */
export type OrbitTarget = readonly [string, string] | readonly [string, string, OrbitFractal]

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

type Fixed = [bigint, bigint]

function times([ar, ai]: Fixed, [br, bi]: Fixed): Fixed {
  return [(ar * br - ai * bi) >> FRACTION_BITS, (ar * bi + ai * br) >> FRACTION_BITS]
}

function step(z: Fixed, fractal: OrbitFractal): Fixed {
  switch (fractal) {
    case 'multibrot3':
      return times(times(z, z), z)
    case 'multibrot4':
      return times(times(z, z), times(z, z))
    case 'tricorn': {
      const [zr, zi] = times(z, z)
      return [zr, -zi]
    }
    case 'burning-ship': {
      const positive: Fixed = [z[0] < 0n ? -z[0] : z[0], z[1] < 0n ? -z[1] : z[1]]
      return times(positive, positive)
    }
    default:
      return times(z, z)
  }
}

/** One row per target, ORBIT_LENGTH texels each: x and y the orbit's point, z 1 while
 * there is a next point to step to - 0 where the orbit escaped, came back
 * to 0 or the row ends, which is where the shader starts over. */
export function referenceOrbits(targets: readonly OrbitTarget[]): Float32Array {
  const data = new Float32Array(ORBIT_LENGTH * targets.length * 4)
  targets.forEach(([re, im, fractal = 'mandelbrot'], row) => {
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
      const size = x * x + y * y
      if (size > ESCAPE_RADIUS_SQUARED || n === ORBIT_LENGTH - 1) break
      if (n > 0 && size < BACK_AT_ZERO_SQUARED) break
      data[at + 2] = 1
      const [nr, ni] = step([zr, zi], fractal)
      zr = nr + cr
      zi = ni + ci
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
