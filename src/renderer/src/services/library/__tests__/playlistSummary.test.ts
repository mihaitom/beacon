import { describe, expect, it } from 'vitest'
import { MAX_COVERS, MAX_GENRES, summarizePlaylist, summaryKey } from '../playlistSummary'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Playlist } from '@/types/library'

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: `List ${id}`,
    songCount: 3,
    duration: 600,
    coverArtId: null,
    public: false,
    owner: 'thomas',
    changed: null,
    songs: [],
    ...overrides,
  }
}

describe('summarizePlaylist', () => {
  it('puts the albums with the most tracks first, each once', () => {
    const summary = summarizePlaylist([
      makeSong('1', { coverArtId: 'a' }),
      makeSong('2', { coverArtId: 'b' }),
      makeSong('3', { coverArtId: 'b' }),
      makeSong('4', { coverArtId: 'c' }),
      makeSong('5', { coverArtId: 'b' }),
      makeSong('6', { coverArtId: 'c' }),
    ])

    expect(summary.covers).toEqual(['b', 'c', 'a'])
  })

  it('keeps playlist order among albums with as many tracks each', () => {
    const summary = summarizePlaylist([
      makeSong('1', { coverArtId: 'z' }),
      makeSong('2', { coverArtId: 'a' }),
      makeSong('3', { coverArtId: 'm' }),
    ])

    expect(summary.covers).toEqual(['z', 'a', 'm'])
  })

  it('skips songs without artwork, genre or artist instead of counting them', () => {
    const summary = summarizePlaylist([
      makeSong('1', { coverArtId: null, genre: null, artist: '' }),
      makeSong('2', { coverArtId: 'a', genre: 'Jazz', artist: 'Miles Davis' }),
    ])

    expect(summary).toEqual({ covers: ['a'], artists: ['Miles Davis'], genres: ['Jazz'] })
  })

  it('ranks artists and genres by how often they appear', () => {
    const summary = summarizePlaylist([
      makeSong('1', { artist: 'Portishead', genre: 'Trip-Hop' }),
      makeSong('2', { artist: 'Radiohead', genre: 'Rock' }),
      makeSong('3', { artist: 'Radiohead', genre: 'Rock' }),
      makeSong('4', { artist: 'Massive Attack', genre: 'Trip-Hop' }),
      makeSong('5', { artist: 'Radiohead', genre: 'Rock' }),
    ])

    expect(summary.artists).toEqual(['Radiohead', 'Portishead', 'Massive Attack'])
    expect(summary.genres).toEqual(['Rock', 'Trip-Hop'])
  })

  it('caps the covers and genres but keeps every artist for the "and N more" count', () => {
    const songs = Array.from({ length: 30 }, (_, i) =>
      makeSong(String(i), { coverArtId: `c${i}`, genre: `g${i}`, artist: `a${i}` }),
    )

    const summary = summarizePlaylist(songs)

    expect(summary.covers).toHaveLength(MAX_COVERS)
    expect(summary.genres).toHaveLength(MAX_GENRES)
    expect(summary.artists).toHaveLength(30)
  })
})

describe('summaryKey', () => {
  it('changes with an edit however the server reports one', () => {
    const base = makePlaylist('p', { changed: '2026-01-01T00:00:00Z' })

    expect(summaryKey({ ...base, changed: '2026-01-02T00:00:00Z' })).not.toBe(summaryKey(base))
    expect(summaryKey({ ...base, songCount: 4 })).not.toBe(summaryKey(base))
    expect(summaryKey({ ...base, duration: 601 })).not.toBe(summaryKey(base))
    expect(summaryKey({ ...base, name: 'Renamed' })).toBe(summaryKey(base))
  })
})
