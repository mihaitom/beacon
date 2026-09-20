/**
 * Shared multi-word matching for every in-app filter field (Songs, Albums,
 * Artists, Genres, Playlists, Radio) — see each view's own `filtered*`
 * computed.
 *
 * Exists because the naive version ("does any one field contain the whole
 * query as one substring") disagreed with the server-side global search
 * (TopBarSearch.vue's search3.view call): searching "Michael Jackson Bad"
 * in the top bar finds the song, since Navidrome/Subsonic's own search
 * index matches each word independently against the record as a whole.
 * The same query in a view's local filter field found nothing — "Michael
 * Jackson" (matches the artist field alone) or "Bad" (matches the title
 * field alone) each worked on their own, but not combined, because the
 * old filter required one single field to contain the *entire* typed
 * string. Splitting the query into words and letting each land in a
 * different field is what actually matches how people search.
 *
 * Since then the comparison has been the shared one (services/stringMatch.ts)
 * that the library matcher uses too: punctuation and apostrophes fold away
 * like accents already did, and a word that is merely misspelled is still
 * accepted when it is close enough to a word in the field.
 */

import { bigramSimilarity, normalize } from './stringMatch'

// A query word shorter than this is not fuzzy-matched: two short words share
// too few bigrams for the score to mean anything, and the substring test
// below already covers the half-typed case ("wond" finds "Wonderwall").
const MIN_FUZZY_LENGTH = 4

// How close a query word has to be to a field word to be that word
// misspelled. High enough that "bush" is not "push" and "oasis" is not
// "basis" (0.67/0.75); low enough that "beattles" finds "beatles" (0.92).
const FUZZY_FLOOR = 0.8

/** Whether one query word is the field word or close enough to it. */
function termMatches(haystack: string, term: string): boolean {
  // Substring, so a half-typed word and a word in the middle of a longer one
  // both land — this is the behaviour the filter always had.
  if (haystack.includes(term)) return true
  if (term.length < MIN_FUZZY_LENGTH) return false
  return haystack.split(' ').some((word) => bigramSimilarity(word, term) >= FUZZY_FLOOR)
}

/**
 * True if every whitespace-separated word in `query` matches at least one of
 * `fields` (case-, accent- and punctuation-insensitive, order-independent —
 * a word can match any field, not necessarily the same one as the previous
 * word). A word matches as a substring or, when it is long enough, as a
 * near-match to a word in the field. An empty/whitespace-only query matches
 * everything, same as leaving a filter field blank always has.
 */
export function matchesAllTerms(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = normalize(query).split(' ').filter(Boolean)
  if (terms.length === 0) return true
  const haystacks = fields.filter((f): f is string => !!f).map((f) => normalize(f))
  return terms.every((term) => haystacks.some((haystack) => termMatches(haystack, term)))
}
