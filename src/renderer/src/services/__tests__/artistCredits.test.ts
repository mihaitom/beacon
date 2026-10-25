import { describe, expect, it } from 'vitest'
import { creditsArtist, participants, splitCredit } from '../artistCredits'
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

describe('splitCredit', () => {
  // Keyed the way the library store keys its artists: artistNameKey().
  const library = new Map([
    ['galantis', 'galantis'],
    ['dolly parton', 'dolly'],
    ['mr. probz', 'probz'],
    ['the magician', 'magician'],
    ['years & years', 'years'],
    ['simon & garfunkel', 'sg'],
    ['lucas & steve', 'ls'],
    ['ilira', 'ilira'],
    ['89ers', '89ers'],
    ['michael rivera', 'rivera'],
    ['darius & finlay', 'df'],
    ['darius', 'darius'],
  ])

  it('gives every known performer their own link', () => {
    expect(splitCredit('Galantis & Dolly Parton feat. Mr. Probz', library)).toEqual([
      { name: 'Galantis', id: 'galantis' },
      { name: 'Dolly Parton', id: 'dolly' },
      { name: 'Mr. Probz', id: 'probz' },
    ])
  })

  it('splits a credit the server made an artist of its own', () => {
    // Navidrome's entity for a credit tagged as one string; the performers
    // in it are the pages anyone wants.
    const withCombined = new Map([...library, ['galantis & dolly parton', 'combined']])
    expect(splitCredit('Galantis & Dolly Parton', withCombined, 'combined')).toEqual([
      { name: 'Galantis', id: 'galantis' },
      { name: 'Dolly Parton', id: 'dolly' },
    ])
  })

  it('splits on the multiplication sign', () => {
    expect(splitCredit('Galantis × Lucas & Steve × ILIRA', library)).toEqual([
      { name: 'Galantis', id: 'galantis' },
      { name: 'Lucas & Steve', id: 'ls' },
      { name: 'ILIRA', id: 'ilira' },
    ])
  })

  it('prefers the longest known name over its first word', () => {
    // "Darius" is an artist too - the duo still wins.
    expect(splitCredit('89ers, Michael Rivera & Darius & Finlay', library)).toEqual([
      { name: '89ers', id: '89ers' },
      { name: 'Michael Rivera', id: 'rivera' },
      { name: 'Darius & Finlay', id: 'df' },
    ])
  })

  it('keeps an artist whose name contains a separator whole', () => {
    expect(splitCredit('The Magician feat. Years & Years', library)).toEqual([
      { name: 'The Magician', id: 'magician' },
      { name: 'Years & Years', id: 'years' },
    ])
    expect(splitCredit('Simon & Garfunkel', library)).toEqual([
      { name: 'Simon & Garfunkel', id: 'sg' },
    ])
  })

  it('leaves names the library does not know as written', () => {
    // Splitting these would invent artists - "Earth · Wind · Fire".
    expect(splitCredit('Galantis feat. Earth, Wind & Fire', library)).toEqual([
      { name: 'Galantis', id: 'galantis' },
      { name: 'Earth, Wind & Fire', id: null },
    ])
  })

  it('returns a credit with nothing known in it unchanged, on the server id', () => {
    // The library not loaded yet: the line must look like it did before.
    expect(splitCredit('Earth, Wind & Fire', new Map(), 'ewf')).toEqual([
      { name: 'Earth, Wind & Fire', id: 'ewf' },
    ])
    expect(splitCredit('Galantis & Dolly Parton', new Map(), 'combined')).toEqual([
      { name: 'Galantis & Dolly Parton', id: 'combined' },
    ])
  })

  it('ignores case and stray space when matching', () => {
    expect(splitCredit('  the MAGICIAN ft.  years & years ', library)).toEqual([
      { name: 'the MAGICIAN', id: 'magician' },
      { name: 'years & years', id: 'years' },
    ])
  })
})
