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

/** Jaro-Winkler similarity of two *already-normalised* strings, 0..1.
 *
 * The metric the token-level typo match uses (services/textSearch.ts),
 * chosen over the bigram coefficient above because a single missing or extra
 * letter leaves every bigram shifted and scores badly there - "earth" against
 * "erth" is 0.57 - while Jaro-Winkler, which counts matching characters in a
 * window and rewards a shared prefix, stays at 0.94. The prefix bonus is also
 * what keeps a different word sharing a tail ("oasis" against "basis", 0.87)
 * below the match threshold. */
export function jaroWinkler(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1

  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1)
  const leftMatched = Array.from({ length: left.length }, () => false)
  const rightMatched = Array.from({ length: right.length }, () => false)

  let matches = 0
  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - window)
    const end = Math.min(i + window + 1, right.length)
    for (let j = start; j < end; j++) {
      if (rightMatched[j] || left[i] !== right[j]) continue
      leftMatched[i] = true
      rightMatched[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let j = 0
  for (let i = 0; i < left.length; i++) {
    if (!leftMatched[i]) continue
    while (!rightMatched[j]) j++
    if (left[i] !== right[j]) transpositions++
    j++
  }
  transpositions = Math.floor(transpositions / 2)

  const jaro =
    (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3

  let prefix = 0
  const maxPrefix = Math.min(4, left.length, right.length)
  while (prefix < maxPrefix && left[prefix] === right[prefix]) prefix++

  return jaro + prefix * 0.1 * (1 - jaro)
}
