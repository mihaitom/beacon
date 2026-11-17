/** Pure helpers for reshaping the play queue - kept out of the playback
 * store so they can be tested on their own. */
import type { Song } from '@/types/library'

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Clones any song in `songs` that's already the same object reference as
 * something in `existingQueue` (or repeated within `songs` itself), so
 * addToQueue()/queueNext() never push the literal same Song object into
 * the queue twice. Two queue slots sharing one object reference is what let
 * QueueDrawer.vue's per-row identity (keyed off the object, not `id` —
 * needed since the same *song* can legitimately be queued more than once)
 * collide between unrelated rows. Only clones on an actual collision — the
 * overwhelmingly common case (no repeats) still pushes the original
 * reference unchanged, same as before this existed. */
export function dedupeForQueue(songs: Song[], existingQueue: Song[]): Song[] {
  const seen = new Set<Song>(existingQueue)
  return songs.map((t) => {
    if (seen.has(t)) return { ...t }
    seen.add(t)
    return t
  })
}

/** `queue` with `song` moved to right after `index` - a locked next song
 * kept in place across a reshuffle (see the playback store's lockedNextIndex). */
export function keptAfter(queue: Song[], index: number, song: Song): Song[] {
  const rest = [...queue]
  const at = rest.indexOf(song)
  if (at >= 0) rest.splice(at, 1)
  const after = at >= 0 && at <= index ? index - 1 : index
  rest.splice(after + 1, 0, song)
  return rest
}

export function shuffledExcept(songs: Song[], keepFirst: Song | null | undefined): Song[] {
  // Removes only the one `keepFirst` instance, not every song sharing its
  // id — a plain .filter() by id would drop *every* occurrence, silently
  // shrinking the queue whenever the same song appears twice in it.
  const rest = [...songs]
  if (keepFirst) {
    const keepIndex = rest.findIndex((t) => t.id === keepFirst.id)
    if (keepIndex >= 0) rest.splice(keepIndex, 1)
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return keepFirst ? [keepFirst, ...rest] : rest
}
