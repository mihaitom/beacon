import { describe, expect, it } from 'vitest'
import { groupLevel, planGroupVolume } from '../groupVolume'

const rooms = (a: number, b: number) =>
  new Map([
    ['sonos:A', a],
    ['sonos:B', b],
  ])

describe('groupVolume', () => {
  it('reads the loudest known level, ignoring speakers without one', () => {
    expect(groupLevel([20, null, 45])).toBe(45)
    expect(groupLevel([null])).toBeNull()
  })

  it('scales from where the speakers stand in relative mode', () => {
    const { volumes } = planGroupVolume(rooms(30, 60), 30, 'relative', null)

    expect([...volumes.values()]).toEqual([15, 30])
  })

  it('keeps its starting point while the speakers sit where it put them', () => {
    const first = planGroupVolume(rooms(30, 60), 0, 'relative', null)
    const back = planGroupVolume(rooms(0, 0), 60, 'relative', first.anchor)

    expect([...back.volumes.values()]).toEqual([30, 60])
  })

  it('tolerates a reading that comes back one off after rounding', () => {
    const first = planGroupVolume(rooms(30, 60), 20, 'relative', null)
    const next = planGroupVolume(rooms(11, 20), 60, 'relative', first.anchor)

    expect([...next.volumes.values()]).toEqual([30, 60])
  })

  it('evens everything out when there is no balance left to keep', () => {
    const { volumes } = planGroupVolume(rooms(0, 0), 25, 'relative', null)

    expect([...volumes.values()]).toEqual([25, 25])
  })
})
