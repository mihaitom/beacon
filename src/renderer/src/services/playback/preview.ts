/** Which songs of an album or playlist a preview plays - see
 * docs/plans/preview-with-transitions.md. connect picks which part of each
 * one (connect/core/preview.py). */

import type { Song } from '@/types/library'

export const PREVIEW_SONGS = 6
// Interludes and skits say little about the rest of the album.
const MIN_SECONDS = 45

/** Indices into `songs`: `count` of them spread evenly over the list in
 * its own order, both ends included, so the same list always gives the
 * same preview. Songs shorter than MIN_SECONDS only when nothing else is
 * left; a song of unknown length counts as long enough. */
export function pickPreviewSongs(songs: readonly Song[], count = PREVIEW_SONGS): number[] {
  const all = songs.map((_, i) => i)
  const long = all.filter((i) => !(songs[i]!.duration > 0 && songs[i]!.duration < MIN_SECONDS))
  const pool = long.length ? long : all
  if (pool.length <= count) return pool
  return Array.from(
    { length: count },
    (_, k) => pool[Math.round((k * (pool.length - 1)) / (count - 1))]!,
  )
}
