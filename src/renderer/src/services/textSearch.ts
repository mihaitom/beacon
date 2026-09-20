/**
 * Shared multi-word matching for every in-app filter field (Songs, Albums,
 * Artists, Genres, Playlists, Radio) and for the top bar's search over the
 * loaded library — see each view's own `filtered*` computed and
 * stores/library.ts's search().
 *
 * Exists because the naive version ("does any one field contain the whole
 * query as one substring") disagreed with the server-side global search it
 * once deferred to: searching "Michael Jackson Bad" there found the song,
 * since the server's index matches each word independently against the record
 * as a whole. The same query in a view's local filter field found nothing —
 * "Michael Jackson" (matches the artist field alone) or "Bad" (matches the
 * title field alone) each worked on their own, but not combined, because the
 * old filter required one single field to contain the *entire* typed string.
 * Splitting the query into words and letting each land in a different field is
 * what actually matches how people search.
 *
 * The comparison is the shared one (services/stringMatch.ts) that the library
 * matcher uses too: punctuation and apostrophes fold away like accents already
 * did, and a word that is merely misspelled is still accepted when it is close
 * enough to a word in the field. scoreAllTerms() additionally rates *how
 * well* each field answers the query, which is what lets a result list put an
 * exact title above one that merely contains the word.
 *
 * The exact mode (no misspellings, but a prefix or a substring still counts)
 * is a single app-wide preference rather than a per-field argument: it is a
 * way of searching, not a property of one screen, so matchesAllTerms() reads
 * it here and every filter field follows without threading it through each
 * view. The search page's switch is the one place it is set
 * (stores/library.ts).
 */

import { readBooleanPreference, writeBooleanPreference } from './booleanPreference'
import { jaroWinkler, normalize } from './stringMatch'

// Whether matching is whole-word only, remembered across visits.
const EXACT_MATCH_KEY = 'beacon.searchExact'

let exactMatching = readBooleanPreference(EXACT_MATCH_KEY)

/** Whether the exact mode is on — for a caller that ranks rather than filters
 * (stores/library.ts's search()). */
export function exactMatchingEnabled(): boolean {
  return exactMatching
}

/** Turns the exact mode on or off and remembers it. Called from the search
 * page's switch; every matchesAllTerms() caller follows from here. */
export function setExactMatching(value: boolean): void {
  exactMatching = value
  writeBooleanPreference(EXACT_MATCH_KEY, value)
}

// A query word shorter than this is not fuzzy-matched: two short words share
// too few characters for the score to mean anything, and the substring test
// below already covers the half-typed case ("wond" finds "Wonderwall").
const MIN_FUZZY_LENGTH = 4

// How close a query word has to be to a field word to be that word
// misspelled. Jaro-Winkler rather than the bigram coefficient the library
// matcher uses: a single missing letter ("earth" / "erth") shifts every
// bigram and scores 0.57 there, while Jaro-Winkler stays at 0.94. High enough
// that a different word sharing a tail ("oasis" / "basis", 0.87) is not
// accepted.
const FUZZY_FLOOR = 0.9

// What each kind of hit is worth, in descending order: the field is the word
// exactly, the word is one of its words, a word starts with it, it sits
// somewhere inside, or a word is close enough to be it misspelled. The gaps
// are what rank an exact title above a longer one containing the word, and
// both above a misspelling.
const EXACT_FIELD = 1
const EXACT_WORD = 0.9
const PREFIX_WORD = 0.7
const SUBSTRING = 0.5
const FUZZY_WORD = 0.4

/** How well one field answers one query term, 0 when it does not. `exact`
 * keeps the fragment matches (a prefix or a substring of a word) but drops
 * the misspelling one: the letters typed have to be there, in order. */
function termScore(field: string, term: string, exact: boolean): number {
  if (field === term) return EXACT_FIELD
  const words = field.split(' ')
  if (words.includes(term)) return EXACT_WORD
  if (words.some((word) => word.startsWith(term))) return PREFIX_WORD
  // Substring, so a word in the middle of a longer one still lands — this is
  // the behaviour the filter always had, and "exact" does not take it away.
  if (field.includes(term)) return SUBSTRING
  if (exact) return 0
  if (term.length < MIN_FUZZY_LENGTH) return 0
  return words.some((word) => jaroWinkler(word, term) >= FUZZY_FLOOR) ? FUZZY_WORD : 0
}

/** One field a search may match, and how much it counts against the others. */
export interface MatchField {
  text: string | null | undefined
  /** Relative importance; defaults to 1. */
  weight?: number
}

export interface MatchOptions {
  /** Exact spelling: a prefix or a substring of a word still matches, a
   * misspelling does not. */
  exact?: boolean
}

/**
 * How strongly `fields` answer `query`, for ranking a result list: 0 when any
 * word of the query matches nowhere — so this doubles as the match test — and
 * otherwise the sum of each word's best field match, weighted per field.
 *
 * The weights are what keep a search for a title landing on the title: given
 * a song, the title outranks the artist outranks the album, so a title match
 * beats a song that merely shares the word somewhere else.
 */
export function scoreAllTerms(
  query: string,
  fields: MatchField[],
  options: MatchOptions = {},
): number {
  const terms = normalize(query).split(' ').filter(Boolean)
  if (terms.length === 0) return 0
  const exact = options.exact ?? false
  const haystacks = fields
    .filter((field): field is { text: string; weight?: number } => !!field.text)
    .map((field) => ({ text: normalize(field.text), weight: field.weight ?? 1 }))

  let total = 0
  for (const term of terms) {
    let best = 0
    for (const field of haystacks) {
      best = Math.max(best, termScore(field.text, term, exact) * field.weight)
    }
    if (best === 0) return 0
    total += best
  }
  return total
}

/** The items whose fields answer `query`, best match first, with the ones
 * that do not match at all dropped. Ties keep the given order (a stable
 * sort), so equal-scoring results do not shuffle between searches. */
export function rankByMatch<T>(
  items: T[],
  query: string,
  fields: (item: T) => MatchField[],
  options?: MatchOptions,
): T[] {
  return items
    .map((item) => ({ item, score: scoreAllTerms(query, fields(item), options) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}

/**
 * True if every whitespace-separated word in `query` matches at least one of
 * `fields` (case-, accent- and punctuation-insensitive, order-independent —
 * a word can match any field, not necessarily the same one as the previous
 * word). A word matches as a prefix, a substring or, when it is long enough,
 * as a near-match to a word in the field; with the exact mode on, the
 * near-match is dropped and only what was typed counts. An empty/whitespace-
 * only query matches everything, same as leaving a filter field blank always
 * has.
 *
 * `options.exact` defaults to the app-wide mode; a view that shows a switch
 * beside its field passes its own reactive copy so the list follows the
 * toggle (see stores/library.ts's searchExact).
 */
export function matchesAllTerms(
  query: string,
  fields: (string | null | undefined)[],
  options: MatchOptions = {},
): boolean {
  if (normalize(query).split(' ').filter(Boolean).length === 0) return true
  const exact = options.exact ?? exactMatching
  return (
    scoreAllTerms(
      query,
      fields.map((text) => ({ text })),
      { exact },
    ) > 0
  )
}
