/**
 * What a connected media server can actually do — a single lookup table
 * views/stores check instead of scattering `serverType === 'jellyfin'`
 * comparisons across the codebase. Jellyfin's bridge (see
 * connect/media/jellyfin_bridge.py) deliberately doesn't implement every
 * Subsonic endpoint Navidrome does (no personal 1-5 star ratings, no
 * library-rescan trigger) — this is what hides the corresponding UI
 * instead of showing a dead-end control.
 *
 * Adding Plex later touches exactly this one function — no call site
 * elsewhere needs to change.
 */
export interface ServerCapabilities {
  /** 1–5 star personal rating (setRating.view) — Jellyfin only has a
   * boolean favorite, no personal rating scale. */
  personalRating: boolean
  /** Internet radio station management + the /radio nav item. Jellyfin
   * itself has no concept of user-managed stations, but connect hosts its
   * own station list for Jellyfin sessions instead (see
   * core/radio_stations.py) — true for both server types. */
  internetRadio: boolean
  /** Triggering a library rescan from Settings — Navidrome-specific
   * (startScan.view/getScanStatus.view), not bridged for Jellyfin. */
  libraryScan: boolean
  /** Track/Artist Radio (getSimilarSongs2.view) — Navidrome's own
   * recommendation engine, not bridged for Jellyfin. */
  trackRadio: boolean
  /** The Stats/"Wrapped" page's playCount-based sections — not bridged for
   * Jellyfin (see jellyfin_bridge.py's module docstring). */
  playHistoryStats: boolean
}

const SUBSONIC_CAPABILITIES: ServerCapabilities = {
  personalRating: true,
  internetRadio: true,
  libraryScan: true,
  trackRadio: true,
  playHistoryStats: true,
}

const JELLYFIN_CAPABILITIES: ServerCapabilities = {
  personalRating: false,
  internetRadio: true,
  libraryScan: false,
  trackRadio: false,
  playHistoryStats: false,
}

export function capabilitiesFor(serverType: string): ServerCapabilities {
  return serverType === 'jellyfin' ? JELLYFIN_CAPABILITIES : SUBSONIC_CAPABILITIES
}
