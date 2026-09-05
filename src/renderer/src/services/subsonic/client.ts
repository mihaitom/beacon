import md5 from 'blueimp-md5'
import type {
  AlbumList2Response,
  AlbumResponse,
  ArtistResponse,
  ArtistsResponse,
  InternetRadioStationsResponse,
  LyricsBySongIdResponse,
  PlaylistResponse,
  PlaylistsResponse,
  RawSong,
  RawSongDetail,
  ScanStatusResponse,
  UserResponse,
  SearchResult3Response,
  SimilarSongs2Response,
  Starred2Response,
  StructuredLyrics,
} from './types'
import { mapAlbum, mapArtist, mapPlaylist, mapRadioStation, mapSong } from './mappers'
import type { Album, Artist, Playlist, RadioStation, Song } from '@/types/library'
import type { StreamQuality } from '@/services/streamQuality'

const API_VERSION = '1.16.1'
const APP_NAME = 'beacon'

/**
 * Builds a Subsonic auth query string (u/t/s/v/c) from a username+password.
 * This exact string is what connect/media/subsonic.py expects as `/config`'s
 * `credential` field (it parses it back with parse_qs) — and it's reused
 * as-is for Beacon's own Subsonic calls through the proxy, since the proxy
 * is a stateless passthrough that does not know about `/config` at all.
 */
export function buildSubsonicCredential(username: string, password: string): string {
  const salt = cryptoRandomSalt()
  const token = md5(password + salt)
  const params = new URLSearchParams({
    u: username,
    t: token,
    s: salt,
    v: API_VERSION,
    c: APP_NAME,
  })
  return params.toString()
}

function cryptoRandomSalt(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** How far a running library scan has got. Which of the two numbers is
 * available depends on the server, and neither is guaranteed: Navidrome
 * counts items, the Jellyfin and Plex bridges report a percentage, and a
 * server that says nothing leaves both null — see SettingsView.vue, which
 * shows whichever it has. */
export interface ScanProgress {
  scanning: boolean
  count: number | null
  percent: number | null
}

function scanProgress(data: ScanStatusResponse): ScanProgress {
  return {
    scanning: data.scanStatus.scanning,
    count: data.scanStatus.count ?? null,
    percent: data.scanStatus.progress ?? null,
  }
}

export class SubsonicClient {
  constructor(
    private readonly proxyBaseUrl: string,
    private readonly credential: string,
    // The /rest/* proxy route requires X-Connect-Token/?token= just like every
    // other connect endpoint (see connect/routes/proxy.py + core/auth.py) —
    // it's a separate secret from the Subsonic credential above.
    private readonly connectToken: string = '',
    // Which connect session's SessionState.media to bridge through for a
    // Jellyfin-backed login (see connect/media/jellyfin_bridge.py) — inert
    // for a Subsonic session, since routes/proxy.py's passthrough branch
    // doesn't look at it, but required for Jellyfin: without it every /rest
    // request here would resolve to the unconfigured DEFAULT_SESSION_ID
    // instead of the session /config actually set up.
    private readonly sessionId: string = '',
  ) {}

  private authParams(): URLSearchParams {
    const params = new URLSearchParams(this.credential)
    if (!params.has('f')) params.set('f', 'json')
    return params
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'X-Connect-Token': this.connectToken }
    if (this.sessionId) headers['X-Connect-Session'] = this.sessionId
    return headers
  }

  private async get<T>(endpoint: string, extra: Record<string, string> = {}): Promise<T> {
    const params = this.authParams()
    for (const [key, value] of Object.entries(extra)) params.set(key, value)

    const response = await fetch(`${this.proxyBaseUrl}/rest/${endpoint}?${params.toString()}`, {
      headers: this.requestHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Subsonic request failed: ${response.status}`)
    }
    const data = await response.json()
    const subsonic = data['subsonic-response']
    if (subsonic?.status !== 'ok') {
      throw new Error(`Subsonic error ${subsonic?.error?.code}: ${subsonic?.error?.message}`)
    }
    return subsonic as T
  }

  async ping(): Promise<boolean> {
    try {
      await this.get('ping.view')
      return true
    } catch {
      return false
    }
  }

  /** streamUrl/coverArtUrl become raw <audio src>/<img src> values — the
   * browser can't attach custom headers for those, so both the connect
   * token and the session id (see the constructor's sessionId comment)
   * have to travel as query params instead (require_token/get_session both
   * accept query-param fallbacks, see connect/core/auth.py + session.py).
   *
   * `quality` other than 'original' points at connect's own transcoder
   * (connect/routes/local_stream.py) instead of the media server's bytes.
   * Two different endpoints rather than a flag on one, deliberately: the
   * untouched path keeps working exactly as it always has — same URL, same
   * Range handling by the media server itself — instead of gaining a
   * second implementation that has to be kept identical to the first. */
  streamUrl(songId: string, quality: StreamQuality = { format: 'original', bitrate: 0 }): string {
    const params = this.authParams()
    if (this.connectToken) params.set('token', this.connectToken)
    if (this.sessionId) params.set('session', this.sessionId)
    if (quality.format !== 'original') {
      // No Subsonic auth params here — connect resolves the source itself
      // from the session's own media client, the same way casting does.
      const transcodeParams = new URLSearchParams()
      if (this.connectToken) transcodeParams.set('token', this.connectToken)
      if (this.sessionId) transcodeParams.set('session', this.sessionId)
      transcodeParams.set('fmt', quality.format)
      transcodeParams.set('br', String(quality.bitrate))
      return `${this.proxyBaseUrl}/stream/local/${encodeURIComponent(songId)}?${transcodeParams.toString()}`
    }
    params.set('id', songId)
    return `${this.proxyBaseUrl}/rest/stream.view?${params.toString()}`
  }

  coverArtUrl(coverArtId: string, size = 300): string | null {
    if (!coverArtId) return null
    const params = this.authParams()
    params.set('id', coverArtId)
    params.set('size', String(size))
    if (this.connectToken) params.set('token', this.connectToken)
    if (this.sessionId) params.set('session', this.sessionId)
    return `${this.proxyBaseUrl}/rest/getCoverArt.view?${params.toString()}`
  }

  /** Whether an image URL goes through our own proxy, i.e. whether JS is
   * allowed to read its bytes.
   *
   * The distinction decides how CoverArt.vue loads it. Our proxy answers
   * with CORS headers (see connect/main.py), so an image from it can be
   * fetched, held and — the point of doing so — aborted again. A foreign
   * host generally sends no such headers, and a fetch there fails outright
   * where a plain <img src> would have rendered it: artist photos come from
   * the media server as pre-signed URLs on someone else's CDN, and radio
   * favicons from the station's own site. Those keep the <img> path, which
   * can't be cancelled but also never lands on the infrastructure this is
   * protecting. */
  isProxyUrl(url: string): boolean {
    return url.startsWith(`${this.proxyBaseUrl}/`)
  }

  async getAlbumList2(
    type: 'alphabeticalByName' | 'newest' | 'frequent' | 'recent' | 'random' = 'alphabeticalByName',
    size = 100,
    offset = 0,
  ): Promise<Album[]> {
    const data = await this.get<AlbumList2Response>('getAlbumList2.view', {
      type,
      size: String(size),
      offset: String(offset),
    })
    return data.albumList2.album.map(mapAlbum)
  }

  async getAlbum(id: string): Promise<Album> {
    const data = await this.get<AlbumResponse>('getAlbum.view', { id })
    return mapAlbum(data.album)
  }

  /** Single-song lookup by id — used to rebuild a full Song from the
   * connect backend's SSE status (which only gives id/title/artist/album/
   * duration, see StatusSong) after a page reload or a fresh SSE
   * subscription finds playback already in progress. */
  async getSong(id: string): Promise<Song> {
    const data = await this.get<{ song: RawSong }>('getSong.view', { id })
    return mapSong(data.song)
  }

  /** The server's own full record for one track, handed back unmapped.
   *
   * Separate from getSong() above, which narrows the same response down to
   * the library's Song model: the info dialog exists to show what the media
   * server holds, so mapping it through a model that keeps a dozen fields
   * would be throwing away the answer to the question being asked. See
   * services/library/songDetails.ts for what is made of it. */
  async getSongDetails(id: string): Promise<RawSongDetail> {
    const data = await this.get<{ song: RawSongDetail }>('getSong.view', { id })
    return data.song
  }

  /** Embedded/ID3-tag lyrics for one specific file (OpenSubsonic
   * extension) — tried before connect's third-party lookups (see
   * stores/lyrics.ts) since it matches this exact audio file rather than
   * "some song with this name/artist" that may be a different edit.
   * Empty array (not a throw) on servers that don't implement the
   * extension, same as any other "nothing here" case. */
  async getLyricsBySongId(id: string): Promise<StructuredLyrics[]> {
    try {
      const data = await this.get<LyricsBySongIdResponse>('getLyricsBySongId.view', { id })
      return data.lyricsList?.structuredLyrics ?? []
    } catch {
      return []
    }
  }

  async getArtists(): Promise<Artist[]> {
    const data = await this.get<ArtistsResponse>('getArtists.view')
    return data.artists.index.flatMap((index) => index.artist.map(mapArtist))
  }

  async getArtist(id: string): Promise<Artist> {
    const data = await this.get<ArtistResponse>('getArtist.view', { id })
    return mapArtist(data.artist)
  }

  /** Whether this account may do the things a server reserves for its
   * administrators — a library scan being the only one Beacon offers (see
   * startScan() below, `adminOnly` in Navidrome's own route table).
   *
   * Null when the server didn't say: getUser.view is standard Subsonic but
   * not universal across the OpenSubsonic-compatible servers out there,
   * and a missing answer must not be read as "not an admin" — that would
   * hide a working button. Callers treat null as "leave it visible".
   *
   * Only ever asks about the caller's own username, which is all any
   * Subsonic server allows here anyway. */
  async isAdmin(username: string): Promise<boolean | null> {
    try {
      const data = await this.get<UserResponse>('getUser.view', { username })
      return data.user?.adminRole ?? null
    } catch {
      return null
    }
  }

  async getPlaylists(): Promise<Playlist[]> {
    const data = await this.get<PlaylistsResponse>('getPlaylists.view')
    return data.playlists.playlist.map(mapPlaylist)
  }

  async getPlaylist(id: string): Promise<Playlist> {
    const data = await this.get<PlaylistResponse>('getPlaylist.view', { id })
    return mapPlaylist(data.playlist)
  }

  async createPlaylist(name: string, songIds: string[] = []): Promise<void> {
    const params: Record<string, string> = { name }
    await this.getMulti('createPlaylist.view', params, { songId: songIds })
  }

  async addToPlaylist(playlistId: string, songIds: string[]): Promise<void> {
    await this.getMulti('updatePlaylist.view', { playlistId }, { songIdToAdd: songIds })
  }

  async removeFromPlaylist(playlistId: string, songIndexes: number[]): Promise<void> {
    await this.getMulti(
      'updatePlaylist.view',
      { playlistId },
      { songIndexToRemove: songIndexes.map(String) },
    )
  }

  /** Replaces a playlist's songs with exactly this list, in this order —
   * how reordering is done, since Subsonic has no "move entry" call of its
   * own (updatePlaylist only appends and removes by position).
   *
   * createPlaylist with a playlistId is the API's own documented update
   * form, and one request that either lands whole or not at all: Navidrome
   * clears the track list and re-adds these ids inside a single
   * transaction, so a failure can't leave the playlist half-emptied the
   * way a remove-everything-then-re-add pair could. Name, visibility and
   * comment are untouched by it. The Jellyfin/Plex bridges implement the
   * same call by moving entries into this order (see their own
   * create_playlist).
   *
   * Sends the ids the caller gives it, so callers must pass the playlist's
   * complete list, not just the part currently on screen. */
  async setPlaylistSongs(playlistId: string, songIds: string[]): Promise<void> {
    await this.getMulti('createPlaylist.view', { playlistId }, { songId: songIds })
  }

  async updatePlaylist(id: string, updates: { name?: string; public?: boolean }): Promise<void> {
    const params: Record<string, string> = { playlistId: id }
    if (updates.name !== undefined) params.name = updates.name
    if (updates.public !== undefined) params.public = String(updates.public)
    await this.get('updatePlaylist.view', params)
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.get('deletePlaylist.view', { id })
  }

  async search3(
    query: string,
    songCount = 25,
    albumCount = 25,
    artistCount = 25,
    songOffset = 0,
  ): Promise<{
    artists: Artist[]
    albums: Album[]
    songs: Song[]
    // Only ever present when a Jellyfin bridge answered (see
    // SearchResult3Response's comment) — null/undefined for a real
    // Subsonic/Navidrome server, which has no equivalent concept for a
    // search3.view response.
    totalRecordCount: number | null
  }> {
    const data = await this.get<SearchResult3Response>('search3.view', {
      query,
      songCount: String(songCount),
      albumCount: String(albumCount),
      artistCount: String(artistCount),
      songOffset: String(songOffset),
    })
    return {
      artists: (data.searchResult3.artist ?? []).map(mapArtist),
      albums: (data.searchResult3.album ?? []).map(mapAlbum),
      songs: (data.searchResult3.song ?? []).map(mapSong),
      totalRecordCount: data.searchResult3.totalRecordCount ?? null,
    }
  }

  async getStarred2(): Promise<{ artists: Artist[]; albums: Album[]; songs: Song[] }> {
    const data = await this.get<Starred2Response>('getStarred2.view')
    return {
      artists: (data.starred2.artist ?? []).map(mapArtist),
      albums: (data.starred2.album ?? []).map(mapAlbum),
      songs: (data.starred2.song ?? []).map(mapSong),
    }
  }

  async star(params: { id?: string; albumId?: string; artistId?: string }): Promise<void> {
    await this.get('star.view', filterDefined(params))
  }

  async unstar(params: { id?: string; albumId?: string; artistId?: string }): Promise<void> {
    await this.get('unstar.view', filterDefined(params))
  }

  /** Sets a song/album/artist's personal 1–5 star rating; 0 clears it.
   * Distinct from star()/unstar(), which toggle a plain favorite flag. */
  async setRating(id: string, rating: number): Promise<void> {
    await this.get('setRating.view', { id, rating: String(rating) })
  }

  /** Song Radio — songs similar to `id` (a song, artist, or album id),
   * per Navidrome's own recommendation engine (Jellyfin's InstantMix or
   * Plex's Sonic Analysis for those server types — see the respective
   * bridges). `plexPassRequired` surfaces SimilarSongs2Response's own flag
   * straight through — see its comment; false for every non-Plex session,
   * since only that bridge ever sets it. */
  async getSimilarSongs2(
    id: string,
    count = 100,
  ): Promise<{ songs: Song[]; plexPassRequired: boolean }> {
    const data = await this.get<SimilarSongs2Response>('getSimilarSongs2.view', {
      id,
      count: String(count),
    })
    return {
      songs: (data.similarSongs2.song ?? []).map(mapSong),
      plexPassRequired: data.similarSongs2.plexPassRequired ?? false,
    }
  }

  /** Registers a play with the media server — this is what actually drives
   * getAlbumList2's "recent"/"frequent" sort types and song playCount;
   * without it those lists never change no matter how much is played.
   * submission=false is a "now playing" notification (no count/date
   * update), submission=true is the real play registration. */
  async scrobble(id: string, submission: boolean): Promise<void> {
    await this.get('scrobble.view', { id, submission: String(submission) })
  }

  async getInternetRadioStations(): Promise<RadioStation[]> {
    const data = await this.get<InternetRadioStationsResponse>('getInternetRadioStations.view')
    return data.internetRadioStations.internetRadioStation.map(mapRadioStation)
  }

  async createInternetRadioStation(
    name: string,
    streamUrl: string,
    homePageUrl = '',
  ): Promise<void> {
    await this.get('createInternetRadioStation.view', { name, streamUrl, homepageUrl: homePageUrl })
  }

  async updateInternetRadioStation(
    id: string,
    name: string,
    streamUrl: string,
    homePageUrl = '',
  ): Promise<void> {
    await this.get('updateInternetRadioStation.view', {
      id,
      name,
      streamUrl,
      homepageUrl: homePageUrl,
    })
  }

  async deleteInternetRadioStation(id: string): Promise<void> {
    await this.get('deleteInternetRadioStation.view', { id })
  }

  /** Triggers a Navidrome library scan (a Navidrome/OpenSubsonic extension
   * — not in the base Subsonic API). `fullScan` forces a full re-read of
   * every file's tags instead of Navidrome's default incremental scan
   * (new/changed/removed files only) — much slower, only worth it after
   * e.g. bulk-editing tags outside Navidrome. Returns the scan's own
   * initial status, same shape as getScanStatus() below (Navidrome starts
   * scanning synchronously with this call, so `count` here is already
   * meaningful, not just a stub). */
  async startScan(fullScan = false): Promise<ScanProgress> {
    const data = await this.get<ScanStatusResponse>('startScan.view', {
      fullScan: String(fullScan),
    })
    return scanProgress(data)
  }

  /** Polled while a scan is in progress (see SettingsView.vue) — `scanning`
   * flips back to false once Navidrome's done. */
  async getScanStatus(): Promise<ScanProgress> {
    const data = await this.get<ScanStatusResponse>('getScanStatus.view')
    return scanProgress(data)
  }

  /** Like get(), but also appends one or more repeated-key params (Subsonic's
   * convention for list arguments, e.g. songId=1&songId=2&songId=3). */
  private async getMulti(
    endpoint: string,
    extra: Record<string, string>,
    repeated: Record<string, string[]>,
  ): Promise<void> {
    const params = this.authParams()
    for (const [key, value] of Object.entries(extra)) params.set(key, value)
    for (const [key, values] of Object.entries(repeated)) {
      for (const value of values) params.append(key, value)
    }
    const response = await fetch(`${this.proxyBaseUrl}/rest/${endpoint}?${params.toString()}`, {
      headers: this.requestHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Subsonic request failed: ${response.status}`)
    }
    const data = await response.json()
    const subsonic = data['subsonic-response']
    if (subsonic?.status !== 'ok') {
      throw new Error(`Subsonic error ${subsonic?.error?.code}: ${subsonic?.error?.message}`)
    }
  }
}

function filterDefined(obj: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >
}
