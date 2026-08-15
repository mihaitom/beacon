/** Raw Subsonic/OpenSubsonic JSON shapes (subset actually used by Beacon). */

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
  similarSongs2: { song?: RawSong[] }
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

// startScan.view/getScanStatus.view (Navidrome extension) — count is the
// running total of items scanned so far, meaningful only while scanning is
// true (0/absent otherwise).
export interface ScanStatusResponse {
  scanStatus: {
    scanning: boolean
    count?: number
  }
}
