/**
 * Shared string matching: the normalisation and similarity that the in-app
 * filter fields (services/textSearch.ts) and the library matcher
 * (services/library/lastfmMatcher.ts) compare names with.
 *
 * Exists so the two cannot drift. Both answer the same question — "is this
 * the same name, spelled a little differently?" — and a second, subtly
 * different normalisation in one of them is a bug waiting to happen.
 */

/** Accent folding: "Bohème" and "Boheme" are the same title. NFD splits a
 * precomposed character into its base letter plus a combining mark, which is
 * then dropped. */
export function foldDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Case, accents and punctuation are never the difference between two
 * spellings of one name.
 *
 * Apostrophes are dropped rather than turned into a space: "Don't" and
 * "Dont" are the same word, and spacing it out makes "don t stop" - two
 * words where the other side has one, which costs real similarity. Everything
 * else becomes a space, so that removing it cannot fuse two words into one. */
export function normalize(value: string): string {
  return foldDiacritics(value.toLowerCase())
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Dice coefficient over character bigrams of two *already-normalised*
 * strings: the share of adjacent letter pairs they have in common. Chosen
 * over an edit distance because it barely punishes an extra word at the end
 * ("Song" vs "Song Pt. 2" still scores well) while a reordering or a
 * different word drops the score sharply - which is the shape of the
 * difference between a spelling variant and a different name. Returns 0..1. */
export function bigramSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  // A single-character string has no bigrams at all, so the general path
  // below would score it 0 against everything including itself.
  if (left.length < 2 || right.length < 2) return 0

  const bigrams = new Map<string, number>()
  for (let i = 0; i < left.length - 1; i++) {
    const pair = left.slice(i, i + 2)
    bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1)
  }

  let shared = 0
  for (let i = 0; i < right.length - 1; i++) {
    const pair = right.slice(i, i + 2)
    const remaining = bigrams.get(pair) ?? 0
    if (remaining > 0) {
      bigrams.set(pair, remaining - 1)
      shared++
    }
  }
  return (2 * shared) / (left.length - 1 + (right.length - 1))
}

/** bigramSimilarity() over two raw strings, normalising them first. */
export function similarity(a: string, b: string): number {
  return bigramSimilarity(normalize(a), normalize(b))
}
