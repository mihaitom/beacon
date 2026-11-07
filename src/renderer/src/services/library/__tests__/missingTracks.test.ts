import { describe, expect, it } from 'vitest'
import { findMissingTracks } from '../missingTracks'
import type { DeezerAlbumTrack } from '@/services/connect/deezer'
import { makeSong } from '@/stores/__tests__/fixtures'

function track(title: string, titleShort = title): DeezerAlbumTrack {
  return {
    title,
    titleShort,
    artist: 'Artist',
    duration: 200,
    discNumber: 1,
    trackNumber: 0,
    deezerId: 1,
    album: 'Album',
  }
}

const songs = (...titles: string[]) => titles.map((title, i) => makeSong(`s${i}`, { title }))

const missingTitles = (library: string[], album: DeezerAlbumTrack[]) =>
  findMissingTracks(songs(...library), album).map((m) => m.track.title)

describe('findMissingTracks', () => {
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
    const missing = findMissingTracks(songs('One', 'Three'), album)
    expect(missing.map((m) => [m.track.title, m.position])).toEqual([
      ['Intro', 0],
      ['Two', 1],
      ['Outro', 2],
    ])
  })

  it('places by the matched song, whatever order the library holds the songs in', () => {
    const album = [track('One'), track('Two'), track('Three')]
    const missing = findMissingTracks(songs('Three', 'One'), album)
    expect(missing.map((m) => m.position)).toEqual([2])
  })
})
