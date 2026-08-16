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
  /** Track/Artist Radio — Navidrome's getSimilarSongs2.view is bridged to
   * Jellyfin's InstantMix (see jellyfin_bridge.py's get_similar_songs2),
   * true for both server types. */
  trackRadio: boolean
  /** The Stats/"Wrapped" page's playCount-based sections. Relies on
   * scrobble.view actually reaching the server — bridged for Jellyfin via
   * its session-based /Sessions/Playing + /Sessions/Playing/Stopped
   * reporting (see jellyfin_bridge.py's scrobble), mirroring
   * feishin-connect's approach for a real accumulating per-play count. */
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
  trackRadio: true,
  playHistoryStats: true,
}

export function capabilitiesFor(serverType: string): ServerCapabilities {
  return serverType === 'jellyfin' ? JELLYFIN_CAPABILITIES : SUBSONIC_CAPABILITIES
}
