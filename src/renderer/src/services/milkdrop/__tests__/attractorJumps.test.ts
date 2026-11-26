// The jumps name a system by its number in the preset's table: when the
// table changes order, a jump would quietly land on another system. Runs
// the preset's own equations and reads the caption it arrives at.
import { afterEach, describe, expect, it } from 'vitest'
import attractors from '@/assets/milkdrop/presets/beacon-strange-attractors.json'
import { ATTRACTOR_DESTINATIONS, jumpToSystem } from '../attractorJumps'

type Vars = Record<string, number | number[]>

function running(): (frames: number) => Vars {
  const preset = attractors.preset as { init_eqs_str: string; frame_eqs_str: string }
  const init = new Function('a', preset.init_eqs_str) as (a: Vars) => void
  const frame = new Function('a', preset.frame_eqs_str) as (a: Vars) => void
  const levels = { bass: 1, mid: 1, treb: 1, bass_att: 1, mid_att: 1, treb_att: 1 }
  const screen = { time: 0, pixelsx: 1920, pixelsy: 1080 }
  // Butterchurn's memory every equation shares (1M floats there; the
  // preset's lines end below 256k).
  const a: Vars = { ...levels, ...screen, gmegabuf: Array.from({ length: 262144 }, () => 0) }
  init(a)
  return (frames) => {
    for (let i = 0; i < frames; i++) frame(a)
    return a
  }
}

const caption = (a: Vars) => attractors.captions[(a.q32 as number) - 1]!.text

describe('Strange Attractors jumps', () => {
  afterEach(() => {
    delete (globalThis as { beaconAttractorPick?: unknown }).beaconAttractorPick
  })

  it.each(ATTRACTOR_DESTINATIONS.map((to) => [to.label, to]))(
    'lands "%s" on the system captioned the same',
    (label, to) => {
      const run = running()
      run(3)
      jumpToSystem(to)
      expect(caption(run(1))).toBe(label)
    },
  )

  it('flies over, lets the old figure go and draws the new one in full', () => {
    const run = running()
    run(3)
    jumpToSystem(ATTRACTOR_DESTINATIONS[4]!)
    const a = run(1)
    expect(a.fly).toBeGreaterThan(0)
    expect(a.built).toBeLessThan(10)
    run(1200)
    expect(caption(a)).toBe('Rössler attractor')
    expect(a.fly).toBe(0)
    expect(a.ofade).toBe(0)
    expect(a.built).toBeGreaterThanOrEqual(4096)
  })
})
