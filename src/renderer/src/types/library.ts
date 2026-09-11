/** App-level library models — views/stores/components never touch raw Subsonic field names. */

export interface Song {
  id: string
  title: string
  artist: string
  artistId: string
  album: string
  albumId: string
  duration: number
  trackNumber: number | null
  discNumber: number | null
  year: number | null
  genre: string | null
  coverArtId: string | null
  starred: boolean
  /** User's own 1–5 star rating, 0 when unrated — distinct from `starred`
   * (a plain favorite flag). Set via SubsonicClient.setRating(). */
  rating: number
  playCount: number
  format: string | null
  bitRate: number | null
  /** ReplayGain dB values + true-peak (linear, 0–1) from the source, when
   * present — null when the file/server has none at all. Peaks are used to
   * clip the computed gain so a quiet, heavily-gained master can't push
   * past 0dBFS and audibly distort. See utils/replayGain.ts. */
  replayGain: {
    trackGain?: number
    albumGain?: number
    trackPeak?: number
    albumPeak?: number
  } | null
  // Everything below backs an optional column (see
  // services/library/songColumns.ts) and comes out of the same list
  // response as the fields above - no extra request per row. Optional
  // rather than `| null` like the rest of the model: a Song can also come
  // from a queue snapshot persisted by an older build, which has none of
  // them, and a column reads "the server doesn't report this" the same way
  // whether the field is absent or null.
  /** ISO 8601, when the file was added to the library. */
  added?: string | null
  /** ISO 8601, when this account last played it. */
  lastPlayed?: string | null
  /** Bytes. */
  size?: number | null
  bpm?: number | null
  /** Hz. */
  sampleRate?: number | null
  bitDepth?: number | null
  comment?: string | null
  /** Whatever the server calls the file's location - Navidrome synthesises
   * this one for Subsonic clients unless "Report Real Path" is on. */
  path?: string | null
}

export interface Album {
  id: string
  name: string
  artist: string
  artistId: string
  coverArtId: string | null
  songCount: number
  duration: number
  year: number | null
  genre: string | null
  starred: boolean
  /** User's own 1–5 star rating, 0 when unrated. */
  rating: number
  songs: Song[]
}

export interface Artist {
  id: string
  name: string
  albumCount: number
  coverArtId: string | null
  /** Direct artist-photo URL (getArtists.view only) — prefer over coverArtId
   * when present, it's a real photo rather than an album-cover fallback. */
  imageUrl: string | null
  starred: boolean
  /** User's own 1–5 star rating, 0 when unrated. */
  rating: number
  albums: Album[]
}

export interface Genre {
  name: string
  albumCount: number
  songCount: number
}

export interface Playlist {
  id: string
  name: string
  songCount: number
  duration: number
  coverArtId: string | null
  public: boolean
  owner: string
  songs: Song[]
}

export interface RadioStation {
  id: string
  name: string
  streamUrl: string
  homePageUrl: string | null
  // Radio Browser's own favicon URL (RadioBrowserStation.favicon) — only
  // ever set for a station played straight out of RadioView.vue's discover
  // dialog without being added first (see playBrowsedStation()'s own
  // comment); a saved/library station has no equivalent and relies on
  // homePageUrl scraping instead (see radioFaviconUrl()'s own docstring).
  favicon?: string
}
