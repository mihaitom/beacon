/**
 * Deciding whether a song is really by a given artist.
 *
 * Needed because an artist's page cannot be built from their albums alone:
 * a track on a compilation sits on an album credited to "Various Artists",
 * so the performer owns no album and their page came out empty. The songs
 * have to be found by searching for the name instead, and a search matches
 * titles and albums too - "Yeah Boy" turns up things that merely say it.
 * This is the sieve that goes after it.
 *
 * Erring towards a miss rather than a wrong row: a track that slips through
 * here is one the page does not list, which is what it did for all of them
 * until now. A false match is a stranger's song on somebody's page.
 */

import type { Artist, Song } from '@/types/library'

/**
 * What joins several performers into one `artist` string.
 *
 * Deliberately not exhaustive. "x" and "with" are left out although both
 * are used that way: "x" matches inside far too much, and an artist named
 * "With..." is likelier than a page missing one collaboration. Splitting on
 * "," is kept despite names like "Earth, Wind & Fire" because a whole
 * segment still has to match a whole artist name (see creditsArtist), and
 * that name is checked unsplit first.
 */
// The word forms need the lookahead rather than a closing \b: after the
// optional dot in "feat." there is no word boundary left to match, and
// without it "ftw" would split as if it were a credit.
const PARTICIPANT_SEPARATOR = /\s*(?:&|;|\/|\+|,|\b(?:featuring|feat|ft|vs)\.?(?=\s))\s*/i

/** Case and surrounding space are never the difference between two artists. */
function normalize(name: string): string {
  return name.trim().toLowerCase()
}

/** The individual performers named in one `artist` credit. */
export function participants(credit: string): string[] {
  return credit
    .split(PARTICIPANT_SEPARATOR)
    .map(normalize)
    .filter((part) => part !== '')
}

/**
 * Every artist name a credit names: the whole string, plus each performer
 * in it. Both, because the two answer different halves of the same
 * question - "Simon & Garfunkel" is one artist *and* looks like two.
 */
export function creditedNames(credit: string): string[] {
  const names = new Set<string>()
  const whole = normalize(credit)
  if (whole) names.add(whole)
  for (const part of participants(credit)) names.add(part)
  return [...names]
}

/**
 * Whether `song` is one of `artist`'s.
 *
 * Three ways to qualify, in the order they can be trusted:
 *
 * 1. The server said so. `artistId` means different things per backend
 *    (Navidrome's track artist, Jellyfin's first one, Plex's album artist),
 *    so it settles the question when it matches and settles nothing when it
 *    does not.
 * 2. The credit is exactly this artist. Checked before any splitting, which
 *    is what keeps "Simon & Garfunkel" and "AC/DC" whole.
 * 3. The artist is one of several named in the credit - the collaboration
 *    and remix case this whole module exists for.
 */
export function creditsArtist(song: Song, artist: Artist): boolean {
  if (song.artistId && artist.id && song.artistId === artist.id) return true
  const name = normalize(artist.name)
  if (!name) return false
  return creditedNames(song.artist).includes(name)
}

/** The lookup key for an artist in a tally built out of creditedNames(). */
export function artistNameKey(name: string): string {
  return normalize(name)
}
