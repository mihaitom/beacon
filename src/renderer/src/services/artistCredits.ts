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
 * are used that way: "x" matches inside far too much (the "×" sign is in,
 * it never appears in a name), and an artist named
 * "With..." is likelier than a page missing one collaboration. Splitting on
 * "," is kept despite names like "Earth, Wind & Fire" because a whole
 * segment still has to match a whole artist name (see creditsArtist), and
 * that name is checked unsplit first.
 */
// The word forms need the lookahead rather than a closing \b: after the
// optional dot in "feat." there is no word boundary left to match, and
// without it "ftw" would split as if it were a credit.
const PARTICIPANT_SEPARATOR = /\s*(?:&|;|\/|\+|,|×|\b(?:featuring|feat|ft|vs)\.?(?=\s))\s*/i

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

/** One piece of a credit as shown: an artist to link to, or text to leave as
 * it is (`id` null). */
export interface CreditPart {
  name: string
  id: string | null
}

/**
 * A credit taken apart for display, each performer on their own.
 *
 * Splitting alone cannot tell "The Magician feat. Years & Years" from three
 * artists, so a performer only stands alone once the library knows them:
 * adjacent pieces are first rejoined into the longest run that names a known
 * artist ("Years" + "Years"), and whatever names no one stays as written,
 * separators included - an "Earth, Wind & Fire" the library has never heard
 * of comes back whole rather than in three. A credit with nothing known in
 * it is returned unchanged, so a library not loaded yet costs nothing.
 *
 * The whole credit being an artist itself settles nothing: Navidrome makes
 * one out of "A & B feat. C" when the tags name them in a single string. It
 * only wins when none of its pieces is known - "Simon & Garfunkel".
 *
 * `idByName` is keyed by artistNameKey(). `fallbackId` is the server's own
 * artistId, used when the credit stays one piece.
 */
export function splitCredit(
  credit: string,
  idByName: ReadonlyMap<string, string>,
  fallbackId: string | null = null,
): CreditPart[] {
  const whole = credit.trim()
  const single = (): CreditPart[] => [
    { name: whole, id: idByName.get(normalize(whole)) ?? (fallbackId || null) },
  ]
  if (!whole) return single()

  // split() with a capture group interleaves names and separators, so name
  // n sits at 2n and a run of names keeps its own separators when rejoined.
  const pieces = whole.split(new RegExp(`(${PARTICIPANT_SEPARATOR.source})`, 'i'))
  const nameCount = (pieces.length + 1) / 2
  const join = (from: number, to: number): string =>
    pieces
      .slice(2 * from, 2 * to + 1)
      .join('')
      .trim()

  const parts: CreditPart[] = []
  let unknownFrom = -1
  const flushUnknown = (to: number): void => {
    if (unknownFrom < 0) return
    const text = join(unknownFrom, to)
    if (text) parts.push({ name: text, id: null })
    unknownFrom = -1
  }
  for (let from = 0; from < nameCount;) {
    // The whole credit is single()'s to give, after every split has failed.
    let to = from === 0 ? nameCount - 2 : nameCount - 1
    while (to >= from && !idByName.has(normalize(join(from, to)))) to--
    if (to < from) {
      if (unknownFrom < 0) unknownFrom = from
      from++
      continue
    }
    flushUnknown(from - 1)
    const name = join(from, to)
    parts.push({ name, id: idByName.get(normalize(name))! })
    from = to + 1
  }
  flushUnknown(nameCount - 1)

  return parts.some((part) => part.id) ? parts : single()
}
