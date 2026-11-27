// The jumps reach into the Milky Way preset's random draws: when its
// equations change what a draw decides, a jump would quietly land somewhere
// else. Runs the preset's own equations and reads which sight it arrived at.
import { afterEach, describe, expect, it } from 'vitest'
import milkyWay from '@/assets/milkdrop/presets/beacon-milky-way.json'
import { MILKY_WAY_DESTINATIONS, jumpTo } from '../milkyWayJumps'

type Vars = Record<string, number>

function flight(): (frames: number) => Vars {
  const preset = milkyWay.preset as { init_eqs_str: string; frame_eqs_str: string }
  const init = new Function('a', preset.init_eqs_str) as (a: Vars) => void
  const frame = new Function('a', preset.frame_eqs_str) as (a: Vars) => void
  const a: Vars = { bass: 1, mid: 1, treb: 1, bass_att: 1, mid_att: 1, treb_att: 1 }
  init(a)
  return (frames) => {
    for (let i = 0; i < frames; i++) frame(a)
    return a
  }
}

/** Jumps, and flies on until arrived. */
function arriveAt(label: string): Vars {
  const fly = flight()
  fly(5)
  jumpTo(MILKY_WAY_DESTINATIONS.find((entry) => entry.label === label)!)
  let a = fly(1)
  for (let i = 0; i < 2000 && !(a.jumped === 1 && a.jt === 0); i++) a = fly(1)
  return a
}

// 1-based into the preset's captions.
const caption = (a: Vars) => milkyWay.captions[a.cap! - 1]!.text

describe('Milky Way jumps', () => {
  afterEach(() => {
    delete (globalThis as { beaconMilkyWayPick?: unknown }).beaconMilkyWayPick
  })

  it.each([
    ['Nebula', 'Emission nebula'],
    ['Neutron star', 'Neutron star'],
    ['Ringed giant', 'Ringed gas giant'],
    ['Earth-like world', 'Earth-like world'],
    ['Binary star', 'Binary star'],
    ['Triple star', 'Triple star'],
  ])('lands "%s" at the sight captioned "%s"', (label, expected) => {
    expect(caption(arriveAt(label))).toBe(expected)
  })

  it('tells the black holes with and without a disc apart', () => {
    const withDisc = arriveAt('Black hole + disc')
    expect(caption(withDisc)).toBe('Black hole')
    expect(withDisc.disc).toBe(1)
    expect(arriveAt('Black hole').disc).toBe(0)
  })

  it('flies through the rings only when asked', () => {
    expect(arriveAt('Through the rings').ringpass).toBe(1)
    expect(arriveAt('Ringed giant').ringpass).toBe(0)
  })

  it('uses a pick once, then goes back to the dice', () => {
    arriveAt('Nebula')
    expect((globalThis as { beaconMilkyWayPick?: unknown }).beaconMilkyWayPick).toBeNull()
  })
})
