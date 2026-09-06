import { accountScopedKey } from '@/services/accountKey'

const STORAGE_KEY = 'beacon.radio-browser-votes'

/** How long a cast vote is remembered, matching the window Radio Browser
 * itself enforces: one vote per station per IP per 24 hours (its published
 * docs still say ten minutes, its server refuses anything inside a day).
 * Entries older than this are dropped on the next read, which is also the
 * only pruning this map needs — nobody votes for enough stations in a day
 * for its size to be a question. */
const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Which stations this account has already voted for, so the Discover
 * dialog's vote button can show a vote as cast instead of inviting a
 * second one that the directory would only refuse.
 *
 * Purely a display aid: Radio Browser is the authority on whether a vote
 * counts, and it decides that per IP — which, since every request goes out
 * through connect, is the Beacon server's for everyone using it. So this
 * map can be wrong in both directions: someone else on the same server may
 * have spent today's vote for a station this device shows as unvoted, and
 * a vote cast from a phone leaves the desktop's button open. Both resolve
 * themselves on the next click, where the real answer comes back and is
 * recorded (see the dialog's own voteForStation()).
 *
 * Device-local and account-scoped like every other stored preference (see
 * services/accountKey.ts), and deliberately separate from
 * services/radioBrowserLinks.ts: that map exists to keep a saved station's
 * directory id around forever, this one is a 24-hour note about an action.
 */
function readVotes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const cutoff = Date.now() - VOTE_WINDOW_MS
    const fresh: Record<string, number> = {}
    for (const [uuid, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && at > cutoff) fresh[uuid] = at
    }
    return fresh
  } catch {
    // Unreadable or unparseable — showing a button as unvoted costs one
    // refused vote at worst, so there is nothing here worth surfacing.
    return {}
  }
}

/** Records that `stationuuid` has had this account's vote for the next 24
 * hours. Called for a refused vote as well as an accepted one: a refusal
 * means the day's vote for that station is spent (by another device, or
 * another person on the same Beacon server), which is exactly what the
 * button should be showing. The clock then starts from the refusal rather
 * than from the original vote, so the button can stay filled for up to a
 * day longer than the directory would actually require — the alternative
 * is a button that keeps inviting a vote that cannot succeed. */
export function rememberRadioBrowserVote(stationuuid: string): void {
  if (!stationuuid) return
  try {
    const votes = readVotes()
    votes[stationuuid] = Date.now()
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(votes))
  } catch {
    // Storage full or unavailable (private window) — the vote itself was
    // still cast, its button just reopens on the next dialog open.
  }
}

/** Every station this device has a fresh vote recorded for — the dialog
 * asks once per search rather than per rendered row. */
export function recentRadioBrowserVotes(): Set<string> {
  return new Set(Object.keys(readVotes()))
}
