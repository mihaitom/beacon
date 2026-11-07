import { describe, expect, it } from 'vitest'
import { compareWithEdition, songsWithMissing } from '../missingTracks'
import type { DeezerAlbumTrack } from '@/services/connect/deezer'
import { makeSong } from '@/stores/__tests__/fixtures'

function track(title: string, titleShort = title, trackNumber = 0): DeezerAlbumTrack {
  return {
    title,
    titleShort,
    artist: 'Artist',
    duration: 200,
    discNumber: 1,
    trackNumber,
    deezerId: 1,
    album: 'Album',
  }
}

const songs = (...titles: string[]) => titles.map((title, i) => makeSong(`s${i}`, { title }))

const missingTitles = (library: string[], album: DeezerAlbumTrack[]) =>
  compareWithEdition(songs(...library), album).missing.map((m) => m.track.title)

describe('compareWithEdition', () => {
  it('finds nothing missing on a complete album, spelling aside', () => {
    const album = [track("Don't Stop"), track('Bohème'), track('Song A')]
    expect(missingTitles(['Dont Stop', 'Boheme', 'song a'], album)).toEqual([])
  })

  it('lists the tracks no song is, in the album order', () => {
    const album = [track('One'), track('Two'), track('Three'), track('Bonus')]
    expect(missingTitles(['One', 'Three'], album)).toEqual(['Two', 'Bonus'])
  })

  it('reads a remaster or a guest credit as the same song', () => {
    const album = [
      track('Touch (2021 Epilogue) [feat. Paul Williams]'),
      track('Get Lucky'),
      track('Lose Yourself to Dance feat. Pharrell Williams'),
    ]
    expect(
      missingTitles(
        ['Touch (feat. Paul Williams)', 'Get Lucky - 2013 Remaster', 'Lose Yourself to Dance'],
        album,
      ),
    ).toEqual([])
  })

  it('lets the plain version claim a song before another version of it can', () => {
    // Deezer's short title of the voice memo is plain "Blank Space" too.
    const album = [track('Blank Space'), track('Blank Space (Voice Memo)', 'Blank Space')]
    expect(missingTitles(['Blank Space'], album)).toEqual(['Blank Space (Voice Memo)'])
  })

  it('matches each song once, so a second version on the album stays missing', () => {
    const album = [track('Song (Remix)', 'Song'), track('Song (Live)', 'Song')]
    expect(missingTitles(['Song'], album)).toEqual(['Song (Live)'])
  })

  it('places a missing track after the song before it on the album', () => {
    const album = [track('Intro'), track('One'), track('Two'), track('Three'), track('Outro')]
    const { missing } = compareWithEdition(songs('One', 'Three'), album)
    expect(missing.map((m) => [m.track.title, m.position])).toEqual([
      ['Intro', 0],
      ['Two', 1],
      ['Outro', 2],
    ])
  })

  it('places by the matched song, whatever order the library holds the songs in', () => {
    const album = [track('One'), track('Two'), track('Three')]
    const { missing } = compareWithEdition(songs('Three', 'One'), album)
    expect(missing.map((m) => m.position)).toEqual([2])
  })

  it("numbers the songs it holds by the edition's own numbering", () => {
    // A single's file tagged as track 1, which is track 6 of the album.
    const album = [
      track('Ready', 'Ready', 1),
      track('Look', 'Look', 6),
      track('So It Goes', 'So It Goes', 7),
    ]
    const library = [makeSong('look', { title: 'Look', trackNumber: 1 })]
    expect(compareWithEdition(library, album).trackNumbers).toEqual({ look: 6 })
  })
})

describe('songsWithMissing', () => {
  it('puts each missing track where the album page shows it', () => {
    const album = [track('Intro'), track('One'), track('Two'), track('Three'), track('Bonus')]
    album.forEach((t, i) => (t.deezerId = i + 1))
    const library = songs('One', 'Three')
    const ids = songsWithMissing(library, compareWithEdition(library, album)).map((s) => s.id)
    expect(ids).toEqual(['deezer:1', 's0', 'deezer:3', 's1', 'deezer:5'])
  })

  it('leaves out a missing track Deezer has no preview of', () => {
    const album = [track('One'), track('Two')]
    album[1]!.deezerId = 0
    const library = songs('One')
    const ids = songsWithMissing(library, compareWithEdition(library, album)).map((s) => s.id)
    expect(ids).toEqual(['s0'])
  })
})
