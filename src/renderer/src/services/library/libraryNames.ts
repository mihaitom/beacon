/**
 * Finding a chart line in the library by its names. A play imported from
 * Last.fm or ListenBrainz knows only those, while the media server's ids are
 * what a cover and a link need.
 *
 * An index rather than lastfmMatcher's bestMatch(), which compares every song
 * for every line. Only spelling and edition markers are forgiven here: a line
 * that finds nothing simply shows no cover.
 */

import { creditedNames } from '@/services/artistCredits'
import { coreTitle } from '@/services/library/lastfmMatcher'
import { normalize } from '@/services/stringMatch'
import type { Artist, Song } from '@/types/library'

/** normalize() again: creditedNames() keeps accents. */
function foldedCredits(credit: string): string[] {
  return creditedNames(credit).map(normalize)
}

class CreditedNames {
  private exact = new Map<string, Song>()
  // Apart from the full names, so that "Song" finds "Song" and not the
  // "Song (Live)" that happens to reduce to the same thing.
  private core = new Map<string, Song>()

  add(credits: string[], name: string, song: Song): void {
    const full = normalize(name)
    const reduced = normalize(coreTitle(name))
    for (const credit of credits) {
      if (full) this.keep(this.exact, `${credit}|${full}`, song)
      if (reduced) this.keep(this.core, `${credit}|${reduced}`, song)
    }
  }

  find(artist: string, name: string): Song | undefined {
    const credits = foldedCredits(artist)
    return (
      this.first(this.exact, credits, normalize(name)) ??
      this.first(this.core, credits, normalize(coreTitle(name)))
    )
  }

  private keep(index: Map<string, Song>, key: string, song: Song): void {
    const kept = index.get(key)
    if (!kept || (!kept.coverArtId && song.coverArtId)) index.set(key, song)
  }

  private first(index: Map<string, Song>, credits: string[], name: string): Song | undefined {
    for (const credit of credits) {
      const song = index.get(`${credit}|${name}`)
      if (song) return song
    }
    return undefined
  }
}

export class LibraryNames {
  private songs = new CreditedNames()
  private albums = new CreditedNames()
  private artists = new Map<string, Artist>()

  constructor(songs: Song[], artists: Artist[]) {
    for (const song of songs) {
      const credits = foldedCredits(song.artist)
      this.songs.add(credits, song.title, song)
      this.albums.add(credits, song.album, song)
    }
    for (const artist of artists) this.artists.set(normalize(artist.name), artist)
  }

  song(artist: string, title: string): Song | undefined {
    return this.songs.find(artist, title)
  }

  /** Any song of the album, which carries its id and cover. */
  album(artist: string, album: string): Song | undefined {
    return this.albums.find(artist, album)
  }

  /** The whole name only: a duo's line must not get one member's photo. */
  artist(name: string): Artist | undefined {
    return this.artists.get(normalize(name))
  }
}
