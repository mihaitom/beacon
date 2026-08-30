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
  /** Triggering a library rescan from Settings. Two conditions, both
   * required: the server type has to expose it at all (all three do now —
   * Navidrome natively, Jellyfin and Plex through their bridges), *and*
   * this particular account has to be allowed to run one —
   * every server that offers a scan reserves it for administrators
   * (`adminOnly` in Navidrome's own route table, RequiresElevation in
   * Jellyfin's API, an admin token in Plex's). Being an admin is a fact
   * about the account, not the server type, so it can't live in the
   * tables below — see capabilitiesFor()'s `isAdmin` argument. */
  libraryScan: boolean
  /** Song/Artist Radio — Navidrome's getSimilarSongs2.view is bridged to
   * Jellyfin's InstantMix (see jellyfin_bridge.py's get_similar_songs2),
   * true for both server types. */
  songRadio: boolean
  /** Lyrics stored with the audio file itself (getLyricsBySongId.view) —
   * asked for before connect's own third-party providers, since they
   * belong to this exact recording rather than to some other edit of a
   * song with the same name (see stores/lyrics.ts's fetchFileLyrics()).
   * False for Plex: its bridge has nothing to answer this with (see
   * media/plex_bridge.py), and without this flag every single track
   * played there would spend a request finding that out again. Lyrics
   * themselves still work everywhere — this only decides whether the
   * file's own copy is worth asking for first. */
  fileLyrics: boolean
  /** The Stats/"Wrapped" page's playCount-based sections. Relies on
   * scrobble.view actually reaching the server — bridged for Jellyfin via
   * its session-based /Sessions/Playing + /Sessions/Playing/Stopped
   * reporting (see jellyfin_bridge.py's scrobble) for a real accumulating
   * per-play count. */
  playHistoryStats: boolean
  /** Settings' "Advanced" section (log-level dropdown) — not actually a
   * media-server capability (it's app-level, see routes/log_level.py's own
   * docstring), reusing this table anyway because it's the one place that
   * already threads isAdmin through to a view via capabilitiesFor(), and a
   * second gating mechanism for one flag isn't worth it. True for every
   * server type; libraryScan's isAdmin===false branch below takes it away
   * the same way it takes the scan button away — connect has no way to
   * check this server-side (POST /log-level only carries CONNECT_TOKEN, an
   * instance-wide secret every client already has, not an admin proof — see
   * that route's own docstring), so this is UI-gating, not real
   * enforcement, same caveat as libraryScan's. */
  logLevelControl: boolean
}

const SUBSONIC_CAPABILITIES: ServerCapabilities = {
  favorites: true,
  emptyPlaylistCreation: true,
  personalRating: true,
  internetRadio: true,
  libraryScan: true,
  songRadio: true,
  fileLyrics: true,
  playHistoryStats: true,
  logLevelControl: true,
}

const JELLYFIN_CAPABILITIES: ServerCapabilities = {
  favorites: true,
  emptyPlaylistCreation: true,
  personalRating: false,
  internetRadio: true,
  // Bridged onto Jellyfin's own library-scan task (see
  // jellyfin_bridge.py's start_scan) — server-admin only, which
  // capabilitiesFor()'s isAdmin argument takes care of.
  libraryScan: true,
  songRadio: true,
  // Jellyfin's own /Audio/{id}/Lyrics, which reads what is tagged in the
  // file or sitting next to it as an .lrc — ordinary user permission, no
  // server-admin rights needed (see jellyfin_bridge.py's
  // get_lyrics_by_song_id()).
  fileLyrics: true,
  playHistoryStats: true,
  logLevelControl: true,
}

// Plex bridges browsing — artists/albums/songs/search/cover art — plus
// internet radio stations (self-hosted, identical logic to Jellyfin's, see
// media/base.py), playback, personal ratings (setRating.view -> Plex's own
// PUT /:/rate, its one native personal-marking mechanism for music) and
// playlist CRUD. Ratings are a real feature-parity win over Jellyfin,
// which has no rating scale at all. favorites is false: Plex's core Media Server REST
// API has no separate boolean favorite to back star.view/unstar.view with
// (see media/plex_bridge.py's module docstring) — the heart icon and the
// Favorites nav item/page hide accordingly instead of leading to a
// dead-end control. playHistoryStats is true: scrobble.view maps onto
// Plex's own PUT /:/scrobble, confirmed live against a real server.
// songRadio is true — bridged onto Plex's own Sonic Analysis
// (`/library/metadata/{id}/nearest`, confirmed live 2026-08-20 — see
// media/plex_bridge.py's get_similar_songs2()) — but
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
  // Bridged onto a refresh of the music section (see plex_bridge.py's
  // start_scan) — owner-only, which capabilitiesFor()'s isAdmin argument
  // takes care of.
  libraryScan: true,
  songRadio: true,
  // Bridged, with one caveat worth knowing: Plex builds a track's lyric
  // stream from a .lrc file next to the audio and ignores lyrics embedded
  // in the file's own tags entirely (verified live 2026-08-27), so a
  // library tagged the way Navidrome and Jellyfin both read happily can
  // still come up empty here — in which case the third-party lookup takes
  // over exactly as it does for an untagged track.
  fileLyrics: true,
  playHistoryStats: true,
  logLevelControl: true,
}

/**
 * `isAdmin` is what the signed-in account may do, as the server itself
 * reports it (see SubsonicClient.isAdmin()) — null means it didn't say, or
 * hasn't been asked yet.
 *
 * Only null and false are told apart deliberately: a server that gives no
 * answer leaves every capability where the server type put it, because
 * hiding a working button on a guess is worse than showing one that turns
 * out to be refused. A definite false is the one case that takes something
 * away.
 */
export function capabilitiesFor(
  serverType: string,
  isAdmin: boolean | null = null,
): ServerCapabilities {
  const base =
    serverType === 'jellyfin'
      ? JELLYFIN_CAPABILITIES
      : serverType === 'plex'
        ? PLEX_CAPABILITIES
        : SUBSONIC_CAPABILITIES
  if (isAdmin === false) return { ...base, libraryScan: false, logLevelControl: false }
  return base
}
