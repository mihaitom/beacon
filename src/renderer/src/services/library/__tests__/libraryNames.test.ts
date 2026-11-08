import { describe, expect, it } from 'vitest'
import { LibraryNames } from '../libraryNames'
import type { Artist, Song } from '@/types/library'

function song(id: string, title: string, artist: string, over: Partial<Song> = {}): Song {
  return { id, title, artist, album: 'Album', albumId: 'alb', coverArtId: id, ...over } as Song
}

function artist(id: string, name: string): Artist {
  return { id, name } as Artist
}

const found = (songs: Song[], who: string, title: string) =>
  new LibraryNames(songs, []).song(who, title)?.id

describe('LibraryNames', () => {
  it('forgives spelling', () => {
    expect(found([song('1', "Don't Stop", 'Beyoncé')], 'beyonce', 'Dont Stop')).toBe('1')
  })

  it('finds a song credited to several performers by one of them', () => {
    expect(found([song('1', 'Song', 'A feat. B & C')], 'A', 'Song')).toBe('1')
  })

  it('finds a song by the lead when the import credits a collaboration', () => {
    expect(found([song('1', 'Song', 'A')], 'A feat. B', 'Song')).toBe('1')
  })

  it('finds a song whose edition is only named on one side', () => {
    expect(found([song('1', 'Song', 'A')], 'A', 'Song - Radio Edit')).toBe('1')
    expect(found([song('1', 'Song (Live)', 'A')], 'A', 'Song')).toBe('1')
  })

  it('prefers the song of that exact name over another edition', () => {
    const songs = [song('live', 'Song (Live)', 'A'), song('studio', 'Song', 'A')]
    expect(found(songs, 'A', 'Song')).toBe('studio')
  })

  it('does not take the same title by somebody else', () => {
    expect(found([song('1', 'Hurt', 'Nine Inch Nails')], 'Christina Aguilera', 'Hurt')).toBe(
      undefined,
    )
  })

  it('prefers a copy that has a cover', () => {
    const songs = [song('bare', 'Song', 'A', { coverArtId: null }), song('art', 'Song', 'A')]
    expect(found(songs, 'A', 'Song')).toBe('art')
  })

  it('finds an album, also under its plain name', () => {
    const names = new LibraryNames([song('1', 'S', 'A', { album: 'Record (Deluxe Edition)' })], [])
    expect(names.album('A', 'Record (Deluxe Edition)')?.albumId).toBe('alb')
    expect(names.album('A', 'Record')?.albumId).toBe('alb')
  })

  it('finds an artist by the whole name only', () => {
    const names = new LibraryNames([], [artist('1', 'Sigur Rós')])
    expect(names.artist('sigur ros')?.id).toBe('1')
    expect(names.artist('Sigur Rós & Friends')).toBeUndefined()
  })
})
