/**
 * Shared multi-word matching for every in-app filter field (Songs, Albums,
 * Artists, Genres, Playlists) — see each view's own `filtered*` computed.
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
 */

/**
 * True if every whitespace-separated word in `query` is a substring of at
 * least one of `fields` (case-insensitive, order-independent — a word can
 * match any field, not necessarily the same one as the previous word). An
 * empty/whitespace-only query matches everything, same as leaving a filter
 * field blank always has.
 */
export function matchesAllTerms(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystacks = fields.filter((f): f is string => !!f).map((f) => f.toLowerCase())
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)))
}
