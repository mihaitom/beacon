import { describe, expect, it } from 'vitest'
import { heardAt, loadedThrough, type MixTimelineEntry } from '../mixTimeline'

function entry(t: number, song: string | null, index: number | null, extra = {}): MixTimelineEntry {
  return {
    t,
    song_id: song,
    queue_index: index,
    position: 0,
    playing: true,
    rate: 1,
    start: true,
    ...extra,
  }
}

describe('heardAt', () => {
  const timeline = [
    entry(0, 'a', 0, { position: 30 }),
    entry(100, 'b', 1),
    entry(150, 'b', 1, { position: 50, playing: false, start: false }),
    entry(152, 'b', 1, { position: 50, start: false }),
    entry(200, 'b', 1),
    entry(300, null, null, { start: false }),
  ]

  it('is nothing before the mix begins', () => {
    expect(heardAt(timeline, -1)).toBeNull()
  })

  it('maps stream time into the song playing then', () => {
    expect(heardAt(timeline, 10)).toMatchObject({ songId: 'a', queueIndex: 0, position: 40 })
    expect(heardAt(timeline, 120)).toMatchObject({ songId: 'b', queueIndex: 1, position: 20 })
  })

  it('holds the position while the mix holds the song', () => {
    expect(heardAt(timeline, 151)!.position).toBe(50)
    expect(heardAt(timeline, 160)!.position).toBe(58)
  })

  it('says where this play of a song began, across holds', () => {
    expect(heardAt(timeline, 160)!.startedAt).toBe(100)
    // The same song started over (repeat-one) is a new play.
    expect(heardAt(timeline, 210)!.startedAt).toBe(200)
  })

  it('moves a stretched song at its rate', () => {
    expect(heardAt([entry(0, 'a', 0, { rate: 1.05 })], 10)!.position).toBeCloseTo(10.5)
  })

  it('is nothing once the mix has ended', () => {
    expect(heardAt(timeline, 301)).toBeNull()
  })
})

describe('loadedThrough', () => {
  // A run started by a seek: stream time 0 is 120s into song a.
  const timeline = [
    entry(0, 'a', 0, { position: 120 }),
    entry(80, 'b', 1),
    entry(280, null, null, { start: false }),
  ]

  it("is the loaded end in the heard song's own seconds, not stream time", () => {
    expect(loadedThrough(timeline, 10, 30)).toBe(150)
  })

  it('is null once the load has reached past the heard song', () => {
    expect(loadedThrough(timeline, 10, 90)).toBeNull()
    expect(loadedThrough(timeline, 90, 300)).toBeNull()
  })

  it('is 0 when nothing is loaded', () => {
    expect(loadedThrough(timeline, 10, 0)).toBe(0)
  })
})
