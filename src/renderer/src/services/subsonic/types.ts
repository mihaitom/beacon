/** Raw Subsonic/OpenSubsonic JSON shapes (subset actually used by Beacon). */

export interface RawReplayGain {
  trackGain?: number
  albumGain?: number
  trackPeak?: number
  albumPeak?: number
  baseGain?: number
  fallbackGain?: number
}

export interface RawSong {
  id: string
  title: string
  artist?: string
  artistId?: string
  album?: string
  albumId?: string
  duration?: number
  track?: number
  discNumber?: number
  year?: number
  genre?: string
  coverArt?: string
  starred?: string
  userRating?: number
  playCount?: number
  suffix?: string
  bitRate?: number
  replayGain?: RawReplayGain
}

/**
 * Everything getSong.view can carry about one track, beyond the handful of
 * fields the library models keep (see mappers.ts's mapSong).
 *
 * Deliberately not folded into Song: this is read once, by the info dialog,
 * for one track at a time. Carrying it on every song in a 20000-track
 * library would cost memory and a much larger cache for a set of fields
 * nothing else reads.
 *
 * Every field is optional because every one of them is: a plain Subsonic
 * server sends few of these, Navidrome sends most (they are OpenSubsonic
 * extensions), and the Jellyfin/Plex bridges send whatever those two
 * expose. See services/library/songDetails.ts, which drops whatever is
 * missing rather than showing an empty row.
 */
export interface RawSongDetail extends RawSong {
  path?: string
  size?: number
  contentType?: string
  bitDepth?: number
  samplingRate?: number
  channelCount?: number
  /** When the file was added to the library, ISO 8601. */
  created?: string
  /** When it was last played, ISO 8601. */
  played?: string
  comment?: string
  bpm?: number
  sortName?: string
  musicBrainzId?: string
  isrc?: string[]
  moods?: string[]
  explicitStatus?: string
  /** The tag as written, which multi-artist tracks keep intact ("A feat.
   * B") where the `artists` list below splits them apart. */
  displayArtist?: string
  displayAlbumArtist?: string
  genres?: { name: string }[]
  artists?: { id?: string; name: string }[]
  albumArtists?: { id?: string; name: string }[]
}

export interface RawAlbum {
  id: string
  name: string
  artist?: string
  artistId?: string
  coverArt?: string
  songCount: number
  duration: number
  year?: number
  genre?: string
  starred?: string
  userRating?: number
  song?: RawSong[]
}

export interface RawArtist {
  id: string
  name: string
  albumCount?: number
  coverArt?: string
  // Navidrome/OpenSubsonic extension — a direct, pre-signed artist photo
  // URL (not routed through our proxy, points straight at the Navidrome
  // server). Present on both getArtists.view and getArtist.view entries.
  artistImageUrl?: string
  starred?: string
  userRating?: number
  album?: RawAlbum[]
}

export interface RawArtistIndex {
  name: string
  artist: RawArtist[]
}

export interface RawPlaylist {
  id: string
  name: string
  songCount: number
  duration: number
  coverArt?: string
  public?: boolean
  owner?: string
  entry?: RawSong[]
}

export interface RawRadioStation {
  id: string
  name: string
  streamUrl: string
  homePageUrl?: string
}

export interface AlbumList2Response {
  albumList2: { album: RawAlbum[] }
}

export interface AlbumResponse {
  album: RawAlbum
}

export interface ArtistsResponse {
  artists: { index: RawArtistIndex[] }
}

export interface ArtistResponse {
  artist: RawArtist
}

export interface PlaylistsResponse {
  playlists: { playlist: RawPlaylist[] }
}

export interface PlaylistResponse {
  playlist: RawPlaylist
}

export interface SearchResult3Response {
  searchResult3: {
    artist?: RawArtist[]
    album?: RawAlbum[]
    song?: RawSong[]
    // Jellyfin-bridge-only extra field (see connect/media/jellyfin_bridge.py)
    // — a real Subsonic/Navidrome server never sends this. Lets a paginated
    // bulk load show real progress instead of an indeterminate spinner.
    totalRecordCount?: number | null
  }
}

export interface Starred2Response {
  starred2: {
    artist?: RawArtist[]
    album?: RawAlbum[]
    song?: RawSong[]
  }
}

export interface InternetRadioStationsResponse {
  internetRadioStations: { internetRadioStation: RawRadioStation[] }
}

export interface SimilarSongs2Response {
  similarSongs2: {
    song?: RawSong[]
    /** Only ever present (and true) for a Plex session — see
     * connect/media/plex_bridge.py's get_similar_songs2(): Plex's own Sonic
     * Analysis feature this bridges onto is gated behind an active Plex
     * Pass subscription, and a 403 from Plex gets translated into this
     * flag rather than a thrown error, so a listener without one still
     * gets a real (if empty) response instead of the call failing. */
    plexPassRequired?: boolean
  }
}

// getLyricsBySongId.view (OpenSubsonic extension) — embedded/ID3-tag
// lyrics for one specific file, as opposed to connect's third-party
// lookups which match by name/artist and can land on a different edit of
// the song. `line[].start` (ms) is only present when `synced` is true.
export interface StructuredLyricLine {
  start?: number
  value: string
}

export interface StructuredLyrics {
  lang: string
  synced: boolean
  line: StructuredLyricLine[]
  displayArtist?: string
  displayTitle?: string
  offset?: number
}

export interface LyricsBySongIdResponse {
  lyricsList: { structuredLyrics?: StructuredLyrics[] }
}

// getUser.view — every Subsonic server answers this for the *caller's own*
// username (asking about anyone else is an authorization error), which is
// the only thing Beacon needs it for: whether this account may trigger a
// library scan (see capabilities.ts's libraryScan).
export interface UserResponse {
  user: {
    username: string
    adminRole?: boolean
  }
}

// startScan.view/getScanStatus.view (Navidrome extension) — count is the
// running total of items scanned so far, meaningful only while scanning is
// true (0/absent otherwise). The Jellyfin and Plex bridges answer the same
// two calls but can only report a percentage, never a count: neither server
// exposes one (see their own get_scan_status()), so they send `progress`
// and omit `count` rather than inventing a number.
export interface ScanStatusResponse {
  scanStatus: {
    scanning: boolean
    count?: number
    progress?: number
  }
}
