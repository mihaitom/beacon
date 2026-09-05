import { accountScopedKey } from '@/services/accountKey'

const STORAGE_KEY = 'beacon.radio-browser-links'

/** How many links are kept. A station found through Discover and saved is
 * a deliberate act, so this is a list of dozens in practice, not thousands
 * — the cap only exists so a pathological case cannot grow local storage
 * without bound. Oldest link out first. */
const MAX_LINKS = 200

/**
 * Which saved radio stations came from Radio Browser, so playing one later
 * can be reported back to the directory.
 *
 * Radio Browser counts a "click" as *someone listened to this station*,
 * and that count is what its own popularity ordering is built on — the
 * same ordering Beacon's Discover search offers to sort by. Beacon was
 * only ever reporting the moment a station was found: added to the library
 * or played straight out of the dialog. Every later play of a station
 * already in someone's list, which is the overwhelming majority of
 * listening, went uncounted, so Beacon was taking that ordering without
 * contributing to it.
 *
 * A saved station cannot carry the id itself: it lives on the media server
 * (Navidrome, Jellyfin, ...) with a fixed set of fields, none of them
 * Beacon's to extend. Hence this side map, keyed by the station's stream
 * URL, which is what identifies a station to Radio Browser in the first
 * place and is stable across a rename.
 *
 * Device-local and account-scoped, like every other stored preference (see
 * services/accountKey.ts). A station added on the desktop and played on a
 * phone therefore goes unreported there, which is an accepted limit rather
 * than an oversight: Radio Browser ignores repeat clicks from the same
 * address within a day anyway, so a perfectly-synced map would buy very
 * little.
 */
function readLinks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    // Unreadable or unparseable — a lost link costs a click report, never
    // playback, so there is nothing here worth surfacing.
    return {}
  }
}

/** Records that `streamUrl` is Radio Browser's `stationuuid`. Called both
 * when a station is added to the library and when one is played straight
 * out of the Discover dialog, so either route leaves the link behind. */
export function rememberRadioBrowserStation(streamUrl: string, stationuuid: string): void {
  if (!streamUrl || !stationuuid) return
  try {
    const links = readLinks()
    // Re-inserted rather than left in place, so a station played again
    // moves to the young end of the cap below.
    delete links[streamUrl]
    links[streamUrl] = stationuuid
    const entries = Object.entries(links)
    const kept = entries.length > MAX_LINKS ? entries.slice(entries.length - MAX_LINKS) : entries
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage full or unavailable (private window) — the station still
    // plays, its play just isn't reported.
  }
}

/** Radio Browser's id for a station, or null for one Beacon has no reason
 * to believe came from there (added by hand, or added before this was
 * recorded). */
export function radioBrowserIdFor(streamUrl: string): null | string {
  return readLinks()[streamUrl] ?? null
}
