import type { Song } from '@/types/library'

function rankings(totals: Map<string, number>): Map<string, number> {
  const ordered = [...totals.entries()].sort(
    ([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB),
  )
  return new Map(ordered.map(([key], index) => [key, index]))
}

/** How many places each group has climbed (negative: fallen) compared with
 * its all-time rank without the last 30 days of plays. */
export function chartMovement(
  songs: Song[],
  recentPlays: Record<string, number>,
  keyOf: (song: Song) => string | null,
): Map<string, number> {
  const now = new Map<string, number>()
  const before = new Map<string, number>()
  for (const song of songs) {
    const key = keyOf(song)
    const plays = song.playCount || 0
    if (!key || plays === 0) continue
    now.set(key, (now.get(key) ?? 0) + plays)
    // Never below zero: the server's count can lag behind the log.
    const earlier = Math.max(0, plays - (recentPlays[song.id] ?? 0))
    before.set(key, (before.get(key) ?? 0) + earlier)
  }
  const ranksNow = rankings(now)
  const ranksBefore = rankings(before)
  return new Map(
    [...ranksNow.entries()].map(([key, rank]) => [key, (ranksBefore.get(key) ?? rank) - rank]),
  )
}
