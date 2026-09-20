/**
 * Finding the songs a library actually owns for a list of Last.fm
 * title/artist names (see services/connect/lastfm.ts).
 *
 * Last.fm names a recording the way its scrobblers spelled it, which is
 * rarely the way a local file is tagged: "Song - Radio Edit" against
 * "Song", "A feat. B" against "A", a remix suffix in brackets on one side
 * only. A plain title+artist equality check finds a fraction of a chart
 * even in a library that has most of it, so the comparison has to be
 * deliberately lenient - while staying tight enough that a chart entry the
 * library doesn't have is reported as missing rather than filled with a
 * different song of a similar name. A wrong track in a playlist is worse
 * than an absent one, so every threshold here errs towards the miss.
 *
 * The heuristic (strip bracketed content and version suffixes, compare
 * against both the raw and the stripped title, and let a near-exact title
 * carry a weak artist score) is ported from the matching rules in
 * ~/code/groove, which arrived at them against real chart data. The
 * artist half is not ported: artistCredits.ts already answers "is this
 * song credited to this performer" for this app's own artist pages,
 * including the collaboration and feat. cases, and it is the better
 * answer.
 */

import { creditedNames } from '@/services/artistCredits'
import type { LastfmTrack } from '@/services/connect/lastfm'
import { normalize, similarity } from '@/services/stringMatch'
import type { Song } from '@/types/library'

/** How a song came to be chosen, kept so the dialog can show the user
 * which rows are solid and which were a judgement call. */
export type MatchConfidence = 'exact' | 'close'

export interface TrackMatch {
  song: Song
  confidence: MatchConfidence
}

/** Trailing edition markers, the single most common difference between a
 * scrobbled name and a tagged one. Only the suffix form is stripped ("Song
 * - Live"); the same words inside brackets are removed with the brackets. */
const VERSION_SUFFIX =
  /\s*-\s*(?:radio edit|extended|remix|mix|version|edit|remaster(?:ed)?|live|acoustic|instrumental|mono|stereo)\b.*$/i

/** A title without bracketed additions or a trailing version marker.
 * Deliberately not used *instead* of the full title - "Song (Remix)" and
 * "Song" reduce to the same core, so a library holding only the remix
 * would answer a request for the original with it. Both forms are
 * compared and the better score wins, which keeps an exact full-title
 * match ahead of a core-only one. */
export function coreTitle(title: string): string {
  return title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(VERSION_SUFFIX, ' ')
    .trim()
}

/** Whether a song's credit names this artist, using the same rules as an
 * artist page (whole credit first, then each performer in it) so that
 * "Calvin Harris & Dua Lipa" matches a Last.fm credit of either. */
function creditNames(song: Song): string[] {
  return creditedNames(song.artist).map(normalize)
}

function artistMatchesExactly(song: Song, artist: string): boolean {
  const wanted = normalize(artist)
  if (!wanted) return false
  const names = creditNames(song)
  if (names.includes(wanted)) return true
  // The other direction: Last.fm credits the collaboration ("A feat. B")
  // where the file is tagged with the lead alone.
  return creditedNames(artist).some((name) => names.includes(normalize(name)))
}

function artistScore(song: Song, artist: string): number {
  if (artistMatchesExactly(song, artist)) return 1
  return Math.max(...creditNames(song).map((name) => similarity(name, artist)), 0)
}

function titleScore(song: Song, title: string): number {
  return Math.max(
    similarity(song.title, title),
    similarity(coreTitle(song.title), coreTitle(title)),
  )
}

/** Whether two credits have at least one whole word in common. The one
 * thing that keeps the "a near-exact title carries a weak artist" rule
 * below from matching a cover version: "Hurt" is both Nine Inch Nails and
 * Christina Aguilera, and without this the title alone would let either
 * stand in for the other. */
function sharesArtistWord(song: Song, artist: string): boolean {
  const wanted = new Set(normalize(artist).split(' ').filter(Boolean))
  return creditNames(song)
    .flatMap((name) => name.split(' '))
    .some((word) => word && wanted.has(word))
}

// A title below this is a different song whatever the artist says.
const TITLE_FLOOR = 0.65
// What a title has to reach to stand on its own when the artist string
// disagrees - a remix credit, a featured performer the file omits.
const TITLE_ALONE = 0.85
// Enough of an artist resemblance to accept a merely good title.
const ARTIST_FLOOR = 0.5

/** The best song in `candidates` for one Last.fm name, or null when none
 * of them is close enough to be worth putting in a playlist.
 *
 * `exact` means the credit really names this artist and the title is a
 * strong match; `close` is everything else that got through, which is
 * where a wrong pick would come from if there is one. */
export function bestMatch(candidates: Song[], title: string, artist: string): TrackMatch | null {
  let best: TrackMatch | null = null
  let bestScore = 0

  for (const song of candidates) {
    const titleSim = titleScore(song, title)
    if (titleSim < TITLE_FLOOR) continue

    const artistSim = artistScore(song, artist)
    const exactArtist = artistSim === 1
    const accepted =
      exactArtist ||
      artistSim >= ARTIST_FLOOR ||
      (titleSim >= TITLE_ALONE && sharesArtistWord(song, artist))
    if (!accepted) continue

    // Three terms, in descending weight. The artist dominates: between a
    // near-perfect title by someone else and a good one by the right
    // performer, the right performer is the answer. The full title then
    // breaks ties the stripped one cannot - "Song" and "Song (Remix)"
    // reduce to the same core, so without this the original could be
    // returned for a request for the remix.
    const score = 2 * (exactArtist ? 1 : artistSim) + titleSim + similarity(song.title, title)
    if (score > bestScore) {
      bestScore = score
      best = {
        song,
        confidence: exactArtist && titleSim >= TITLE_ALONE ? 'exact' : 'close',
      }
    }
  }

  return best
}

/** One Last.fm name and what became of it. `match` is null for a track
 * this library does not have - reported rather than dropped, since "37 of
 * 50 found" is the useful answer and a silently shorter playlist is not. */
export interface ResolvedTrack {
  track: LastfmTrack
  match: TrackMatch | null
}

/** How many library searches run at once. The searches go through
 * connect's proxy to the media server, and a chart of 100 issuing 100
 * parallel requests is a burst a small self-hosted server has no reason to
 * absorb - this keeps it to a steady trickle while still being several
 * times quicker than one at a time. */
const SEARCH_CONCURRENCY = 4

/** How many songs a single search asks for. The match is decided here, not
 * by the server's own ranking, so the list has to be long enough to
 * contain the right song even when the server sorts something else first
 * - and short enough not to fetch a page of rows per chart entry. */
const CANDIDATES_PER_SEARCH = 20

/**
 * Looks up every track against the library and reports what was found, in
 * the order Last.fm returned them (a chart is ranked, and a playlist that
 * loses that ordering loses the point of importing a chart).
 *
 * `search` is passed in rather than imported so this can be exercised
 * without a server - and because the caller already holds the right
 * client for the session's server type.
 *
 * A track is looked up as "artist title" first. Only if that finds
 * nothing is the title tried on its own: a bare title search on a common
 * word returns a page of unrelated songs, and running it every time would
 * hand bestMatch() a much bigger field to go wrong in. Both searches are
 * skipped entirely for an empty name.
 */
export async function resolveTracks(
  tracks: LastfmTrack[],
  search: (query: string, limit: number) => Promise<Song[]>,
  onProgress?: (done: number, total: number) => void,
  signal?: { aborted: boolean },
): Promise<ResolvedTrack[]> {
  const results: ResolvedTrack[] = Array.from({ length: tracks.length })
  let cursor = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      const track = tracks[index]
      if (!track || signal?.aborted) return

      let match: TrackMatch | null = null
      try {
        const primary = await search(`${track.artist} ${track.title}`, CANDIDATES_PER_SEARCH)
        match = bestMatch(primary, track.title, track.artist)
        if (!match) {
          const fallback = await search(track.title, CANDIDATES_PER_SEARCH)
          match = bestMatch(fallback, track.title, track.artist)
        }
      } catch {
        // One failed lookup is a track reported as missing, not a failed
        // import - the rest of the chart is still worth having.
        match = null
      }

      results[index] = { track, match }
      onProgress?.(++done, tracks.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, tracks.length) }, () => worker()),
  )
  // An aborted run leaves holes; the caller only uses what was finished.
  return results.filter(Boolean)
}

/** The song ids to put in the playlist: found tracks only, in chart order,
 * each song at most once. Last.fm lists the same recording twice often
 * enough (a single and its album version both charting), and two
 * near-identical names can land on one file - a playlist with the same
 * track twice looks like a bug. */
export function playlistSongIds(resolved: ResolvedTrack[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of resolved) {
    if (!entry.match) continue
    const id = entry.match.song.id
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
