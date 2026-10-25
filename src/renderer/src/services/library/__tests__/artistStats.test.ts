import { describe, expect, it } from 'vitest'
import { artistStatsByName } from '../artistStats'
import { artistNameKey } from '@/services/artistCredits'
import { makeSong } from '@/stores/__tests__/fixtures'

describe('artistStatsByName', () => {
  const songs = [
    makeSong('1', {
      artist: 'Tide',
      genre: 'Rock',
      year: 1999,
      duration: 200,
      playCount: 3,
      lastPlayed: '2026-01-01T00:00:00Z',
      added: '2020-05-01T00:00:00Z',
    }),
    makeSong('2', {
      artist: 'Tide',
      genre: 'Pop',
      year: 2011,
      duration: 100,
      playCount: 4,
      lastPlayed: '2026-03-01T00:00:00Z',
      added: '2019-01-01T00:00:00Z',
    }),
    makeSong('3', { artist: 'Tide feat. Moon', genre: 'Rock', year: 2005, duration: 60 }),
  ]
  const stats = artistStatsByName(songs)
  const tide = stats.get(artistNameKey('Tide'))!

  it('adds up every song the artist is credited on, guest spots too', () => {
    expect(tide.songCount).toBe(3)
    expect(tide.duration).toBe(360)
    expect(tide.playCount).toBe(7)
    expect(stats.get(artistNameKey('Moon'))?.songCount).toBe(1)
  })

  it('names the genre most of the songs carry', () => {
    expect(tide.genre).toBe('Rock')
  })

  it('spans the years and keeps the latest play and addition', () => {
    expect([tide.firstYear, tide.lastYear]).toEqual([1999, 2011])
    expect(tide.lastPlayed).toBe('2026-03-01T00:00:00Z')
    expect(tide.added).toBe('2020-05-01T00:00:00Z')
  })
})
