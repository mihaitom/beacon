import { describe, expect, it } from 'vitest'
import { makeSong } from '@/stores/__tests__/fixtures'
import { chartMovement } from '../chartMovement'

const byId = (song: { id: string }): string => song.id

describe('chartMovement', () => {
  it('shows a song that overtook another in the last 30 days', () => {
    const songs = [makeSong('old', { playCount: 10 }), makeSong('new', { playCount: 12 })]
    const moves = chartMovement(songs, { new: 8 }, byId)
    expect(moves.get('new')).toBe(1)
    expect(moves.get('old')).toBe(-1)
  })

  it('reports nothing when nothing changed places', () => {
    const songs = [makeSong('a', { playCount: 10 }), makeSong('b', { playCount: 5 })]
    expect(chartMovement(songs, { a: 1 }, byId).get('a')).toBe(0)
  })

  it('adds up a whole group', () => {
    const songs = [
      makeSong('1', { artistId: 'x', playCount: 3 }),
      makeSong('2', { artistId: 'x', playCount: 4 }),
      makeSong('3', { artistId: 'y', playCount: 5 }),
    ]
    const moves = chartMovement(songs, { '1': 3, '2': 2 }, (song) => song.artistId)
    expect(moves.get('x')).toBe(1)
  })

  it('survives a log ahead of the server count', () => {
    const songs = [makeSong('a', { playCount: 2 }), makeSong('b', { playCount: 1 })]
    expect(chartMovement(songs, { a: 50 }, byId).get('a')).toBe(1)
  })
})
