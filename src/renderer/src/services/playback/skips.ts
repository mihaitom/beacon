/** Songs skipped in this listening session, for Autoplay to steer away from
 * (stores/playback/queue.ts's maybeAutoplay()).
 *
 * Memory only, and never sent to the media server: a skip is a hint about
 * what fits right now, not a rating. Leaving a song via Next before it
 * would scrobble counts; a song that ended on its own, or was heard past
 * that point, does not. */

// Enough to describe what someone is skipping today; older skips say more
// about a different mood than about this one.
const MAX_SKIPS = 10

const skipped: string[] = []

export function noteSkipped(songId: string): void {
  const existing = skipped.indexOf(songId)
  if (existing !== -1) skipped.splice(existing, 1)
  skipped.push(songId)
  if (skipped.length > MAX_SKIPS) skipped.shift()
}

/** Most recent last. */
export function recentSkips(): string[] {
  return [...skipped]
}

export function clearSkips(): void {
  skipped.length = 0
}
