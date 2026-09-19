import { describe, expect, it } from 'vitest'
import { pickRediscoverSongs, REDISCOVER_MIN_AGE_DAYS } from '../rediscover'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Song } from '@/types/library'

const NOW = Date.parse('2026-09-19T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString()
}

/** A distinct artist per song unless told otherwise, so the per-artist cap
 * only comes into play in the test that is about it. */
function song(id: string, playCount: number, lastPlayed: string | null, artistId = id): Song {
  return makeSong(id, { playCount, lastPlayed, artistId, artist: `Artist ${artistId}` })
}

function pick(songs: Song[], size = 30, random: () => number = () => 0.5): Song[] {
  return pickRediscoverSongs(songs, { size, now: NOW, random })
}

function ids(songs: Song[]): string[] {
  return songs.map((s) => s.id).sort()
}

describe('pickRediscoverSongs', () => {
  it('takes often-played songs that have not been played for a while', () => {
    const songs = [
      song('old-favorite', 20, daysAgo(200)),
      song('recent-favorite', 20, daysAgo(3)),
      song('old-one-off', 1, daysAgo(200)),
    ]
    expect(ids(pick(songs))).toEqual(['old-favorite'])
  })

  it('draws the line at the minimum age', () => {
    const songs = [
      song('just-past', 10, daysAgo(REDISCOVER_MIN_AGE_DAYS + 1)),
      song('just-short', 10, daysAgo(REDISCOVER_MIN_AGE_DAYS - 1)),
    ]
    expect(ids(pick(songs))).toEqual(['just-past'])
  })

  it('measures "often" against the library, not a fixed number', () => {
    // Eight played songs: the top quarter starts at the second-highest
    // count, 40. A song at 10 plays is well above the floor of 2 and still
    // not among this library's most played.
    const songs = [
      song('a', 50, daysAgo(200)),
      song('b', 40, daysAgo(200)),
      song('c', 10, daysAgo(200)),
      ...['d', 'e', 'f', 'g', 'h'].map((id) => song(id, 5, daysAgo(1))),
    ]
    expect(ids(pick(songs))).toEqual(['a', 'b'])
  })

  it('never counts a single play as often, however little the library is played', () => {
    const songs = [song('a', 1, daysAgo(200)), song('b', 1, daysAgo(300))]
    expect(pick(songs)).toEqual([])
  })

  it('leaves out songs with plays but no usable last-played date', () => {
    const songs = [
      song('no-date', 20, null),
      song('bad-date', 20, 'not a date'),
      song('dated', 20, daysAgo(200)),
    ]
    expect(ids(pick(songs))).toEqual(['dated'])
  })

  it('keeps any one artist to two songs', () => {
    const songs = [
      song('a1', 20, daysAgo(200), 'same'),
      song('a2', 20, daysAgo(200), 'same'),
      song('a3', 20, daysAgo(200), 'same'),
      song('b1', 20, daysAgo(200), 'other'),
    ]
    const picked = pick(songs)
    expect(picked.filter((s) => s.artistId === 'same')).toHaveLength(2)
    expect(picked.map((s) => s.id)).toContain('b1')
  })

  it('stops at the requested size', () => {
    const songs = Array.from({ length: 10 }, (_, i) => song(`s${i}`, 20, daysAgo(200)))
    expect(pick(songs, 4)).toHaveLength(4)
  })

  it('favours the songs played most when drawing', () => {
    // Same random number for both: the heavier weight has to be what puts
    // the 40-play song ahead of the 4-play one. The recent songs only keep
    // the "often" line low enough that both are candidates at all.
    const songs = [
      song('light', 4, daysAgo(200)),
      song('heavy', 40, daysAgo(200)),
      ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => song(id, 3, daysAgo(1))),
    ]
    expect(pick(songs, 1).map((s) => s.id)).toEqual(['heavy'])
  })

  it('draws a different set on a different roll', () => {
    const songs = Array.from({ length: 10 }, (_, i) => song(`s${i}`, 20, daysAgo(200)))
    let n = 0
    const ascending = () => (n++ + 1) / 20
    let m = 0
    const descending = () => (20 - m++) / 21
    expect(ids(pick(songs, 3, ascending))).not.toEqual(ids(pick(songs, 3, descending)))
  })

  it('returns nothing for a library nobody has listened to', () => {
    expect(pick([song('a', 0, null), song('b', 0, null)])).toEqual([])
  })
})
