import { describe, expect, it } from 'vitest'
import { creditsArtist, participants } from '../artistCredits'
import type { Artist, Song } from '@/types/library'

function artist(name: string, id = 'a1'): Artist {
  return {
    id,
    name,
    albumCount: 0,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

function song(credit: string, artistId = ''): Song {
  return { id: 's1', title: 'Track', artist: credit, artistId } as Song
}

describe('participants', () => {
  it('splits the ways a credit actually joins performers', () => {
    expect(participants('Dillon Francis & Yeah Boy')).toEqual(['dillon francis', 'yeah boy'])
    expect(participants('Kaytranada feat. Anderson .Paak')).toEqual([
      'kaytranada',
      'anderson .paak',
    ])
    expect(participants('Run The Jewels ft. Zack de la Rocha')).toEqual([
      'run the jewels',
      'zack de la rocha',
    ])
  })

  it('leaves a single name whole', () => {
    expect(participants('Yeah Yeah Yeahs')).toEqual(['yeah yeah yeahs'])
  })
})

describe('creditsArtist', () => {
  it('takes the server at its word when the ids agree', () => {
    // The compilation case this exists for: the album belongs to "Various
    // Artists", so the performer owns nothing and only this says otherwise.
    expect(creditsArtist(song('Yeah Yeah Yeahs', 'a1'), artist('Yeah Yeah Yeahs'))).toBe(true)
  })

  it('matches a performer named among several', () => {
    // artistId here is the *combined* entity's, which is what Navidrome
    // reports for such a track - so the name is the only way through.
    expect(creditsArtist(song('Dillon Francis & Yeah Boy', 'combined'), artist('Yeah Boy'))).toBe(
      true,
    )
  })

  it('keeps a name that contains a separator whole', () => {
    // Checked before any splitting - otherwise this artist could never
    // match their own songs.
    expect(creditsArtist(song('Simon & Garfunkel'), artist('Simon & Garfunkel'))).toBe(true)
    expect(creditsArtist(song('AC/DC'), artist('AC/DC'))).toBe(true)
  })

  it('refuses a song that merely mentions the words', () => {
    // What the search hands back besides the real hits: the sieve's whole
    // job. A stranger's song on somebody's page is the failure that matters.
    expect(creditsArtist(song('Bruce Springsteen'), artist('Yeah Boy'))).toBe(false)
    expect(creditsArtist(song('Yeah Boys United'), artist('Yeah Boy'))).toBe(false)
  })

  it('ignores case and stray space', () => {
    expect(creditsArtist(song('dillon francis  &  YEAH BOY'), artist('Yeah Boy'))).toBe(true)
  })

  it('does not match an artist with no name on a song with no credit', () => {
    expect(creditsArtist(song(''), artist(''))).toBe(false)
  })
})
