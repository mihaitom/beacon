/** App-level library models — views/stores/components never touch raw Subsonic field names. */

export interface Track {
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
  tracks: Track[]
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
  tracks: Track[]
}

export interface RadioStation {
  id: string
  name: string
  streamUrl: string
  homePageUrl: string | null
}
