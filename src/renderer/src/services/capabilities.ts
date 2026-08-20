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
  /** Boolean favorite toggle (star.view/unstar.view/getStarred2.view) —
   * the heart icon, the Favorites nav item/page. True for Subsonic and
   * Jellyfin; false for Plex, whose core Media Server REST API has no
   * separate favorite concept to back it with (see
   * media/plex_bridge.py's module docstring) — only personalRating below
   * exists there. */
  favorites: boolean
  /** Creating a playlist with no songs yet (PlaylistsView's standalone
   * "New Playlist" dialog) — true for Subsonic and Jellyfin; false for
   * Plex, whose playlist-creation endpoint always needs a starting `uri`
   * of at least one item (see media/plex_bridge.py's create_playlist()).
   * SongRow.vue's own "Create new playlist" entry (right-click -> Add to
   * playlist) always seeds at least one song and stays available
   * regardless of this flag — this only gates the name-only dialog. */
  emptyPlaylistCreation: boolean
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
  /** Song/Artist Radio — Navidrome's getSimilarSongs2.view is bridged to
   * Jellyfin's InstantMix (see jellyfin_bridge.py's get_similar_songs2),
   * true for both server types. */
  songRadio: boolean
  /** The Stats/"Wrapped" page's playCount-based sections. Relies on
   * scrobble.view actually reaching the server — bridged for Jellyfin via
   * its session-based /Sessions/Playing + /Sessions/Playing/Stopped
   * reporting (see jellyfin_bridge.py's scrobble) for a real accumulating
   * per-play count. */
  playHistoryStats: boolean
}

const SUBSONIC_CAPABILITIES: ServerCapabilities = {
  favorites: true,
  emptyPlaylistCreation: true,
  personalRating: true,
  internetRadio: true,
  libraryScan: true,
  songRadio: true,
  playHistoryStats: true,
}

const JELLYFIN_CAPABILITIES: ServerCapabilities = {
  favorites: true,
  emptyPlaylistCreation: true,
  personalRating: false,
  internetRadio: true,
  libraryScan: false,
  songRadio: true,
  playHistoryStats: true,
}

// Plex Phase B (see PLEX_PLAN.md) bridges read-only browsing — artists/
// albums/songs/search/cover art — plus internet radio stations (self-
// hosted, identical logic to Jellyfin's, see media/base.py) and playback.
// Phase C added personal ratings (setRating.view -> Plex's own PUT
// /:/rate, its one native personal-marking mechanism for music) and
// playlist CRUD — a real feature-parity win over Jellyfin, which has no
// rating scale at all. favorites is false: Plex's core Media Server REST
// API has no separate boolean favorite to back star.view/unstar.view with
// (see media/plex_bridge.py's module docstring) — the heart icon and the
// Favorites nav item/page hide accordingly instead of leading to a
// dead-end control. playHistoryStats is true: scrobble.view maps onto
// Plex's own PUT /:/scrobble, confirmed live against a real server.
// songRadio is true — bridged onto Plex's own Sonic Analysis
// (`/library/metadata/{id}/nearest`, confirmed live 2026-08-20 — see
// media/plex_bridge.py's get_similar_songs2() and PLEX_PLAN.md) — but
// unlike every other true value here, it's not something *this app*
// controls end to end: Sonic Analysis itself is a Plex Pass-gated feature
// (confirmed against Plex's own support docs), so a listener without an
// active Plex Pass sees the Song/Artist Radio buttons and the Autoplay
// toggle same as everyone else, but they silently return nothing instead
// of a real mix — connect's own bridge turns the 403 that gets back into
// an empty result rather than an error (see get_similar_songs2()'s own
// comment). Left true anyway rather than adding a whole separate "has
// Plex Pass" capability just to hide these for that one case — there's no
// way to know that account-level fact from here without a real call
// first, and a quietly-inert control is a smaller papercut than an
// always-hidden one for every Plex listener regardless of their own
// subscription.
const PLEX_CAPABILITIES: ServerCapabilities = {
  favorites: false,
  emptyPlaylistCreation: false,
  personalRating: true,
  internetRadio: true,
  libraryScan: false,
  songRadio: true,
  playHistoryStats: true,
}

export function capabilitiesFor(serverType: string): ServerCapabilities {
  if (serverType === 'jellyfin') return JELLYFIN_CAPABILITIES
  if (serverType === 'plex') return PLEX_CAPABILITIES
  return SUBSONIC_CAPABILITIES
}
