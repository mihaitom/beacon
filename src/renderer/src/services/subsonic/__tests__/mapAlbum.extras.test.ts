import { describe, expect, it } from 'vitest'
import { mapAlbum } from '../mappers'
import type { RawAlbum } from '../types'

function raw(overrides: Partial<RawAlbum> = {}): RawAlbum {
  return { id: 'al1', name: 'Album', songCount: 1, duration: 60, ...overrides }
}

describe('mapAlbum album-page extras', () => {
  it('carries labels, release types, genres, edition and MusicBrainz id', () => {
    const album = mapAlbum(
      raw({
        recordLabels: [{ name: 'Island' }],
        releaseTypes: ['Album', 'Compilation'],
        genres: [{ name: 'Pop' }, { name: 'R&B' }],
        version: 'Deluxe Edition',
        musicBrainzId: 'mbid-1',
      }),
    )

    expect(album).toMatchObject({
      labels: ['Island'],
      releaseTypes: ['album', 'compilation'],
      genres: ['Pop', 'R&B'],
      version: 'Deluxe Edition',
      musicBrainzId: 'mbid-1',
    })
  })

  it('marks an edition from a later year than the original as a reissue', () => {
    const album = mapAlbum(
      raw({ originalReleaseDate: { year: 2008 }, releaseDate: { year: 2011 } }),
    )

    expect(album.originalYear).toBe(2008)
    expect(album.reissueYear).toBe(2011)
  })

  it('is no reissue when the edition is the original, or undated', () => {
    // Navidrome sends an empty releaseDate object when it has none.
    expect(
      mapAlbum(raw({ originalReleaseDate: { year: 2008 }, releaseDate: { year: 2008 } }))
        .reissueYear,
    ).toBeNull()
    expect(
      mapAlbum(raw({ originalReleaseDate: { year: 2008 }, releaseDate: {} })).reissueYear,
    ).toBeNull()
  })

  it('leaves the extras empty on a server that sends none', () => {
    expect(mapAlbum(raw())).toMatchObject({
      labels: [],
      releaseTypes: [],
      genres: [],
      version: null,
      originalYear: null,
      reissueYear: null,
      musicBrainzId: null,
    })
  })
})
