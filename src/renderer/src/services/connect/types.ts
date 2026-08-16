export type DeviceType = 'sonos' | 'chromecast' | 'dlna' | 'airplay'

export interface ConnectDeviceRef {
  name: string
  type: DeviceType
}

export interface DiscoveredDevice {
  name: string
  // AirPlay-only.
  address?: string
  model?: string
  needs_pairing?: boolean
  // DLNA-only.
  location?: string
  // Sonos-only.
  ip?: string
  in_use_by_session_id?: string | null
  in_use_by_name?: string | null
  in_use_by_track?: string | null
}

export interface DiscoverResponse {
  airplay: DiscoveredDevice[]
  chromecast: DiscoveredDevice[]
  dlna: DiscoveredDevice[]
  sonos: DiscoveredDevice[]
}

export interface DeviceInUseError {
  error: 'device_in_use'
  device: ConnectDeviceRef
  owner: string
}

export interface GenericError {
  error: string
}

export type ConnectError = DeviceInUseError | GenericError

export function isConnectError(value: unknown): value is ConnectError {
  return typeof value === 'object' && value !== null && 'error' in value
}

export function isDeviceInUseError(value: unknown): value is DeviceInUseError {
  return isConnectError(value) && (value as DeviceInUseError).error === 'device_in_use'
}

export interface HealthResponse {
  ffmpeg: boolean
  navidrome_configured: boolean
  // Set only when this deployment is locked to one specific server (see
  // connect/routes/devices.py's SERVER_LOCK/SERVER_URL) — ServerLoginView.vue
  // uses this to skip asking for a server URL/type at all, since there's
  // only ever one possible answer.
  server_lock: { url: string; server_type: string } | null
  // What the *currently authenticated* session is actually talking to —
  // 'subsonic' | 'jellyfin', or null pre-login. Distinct from server_lock
  // above (only set for a locked deployment, even pre-auth) — this is what
  // an unlocked, multi-server deployment uses to gate Navidrome/Jellyfin-
  // specific UI (see services/capabilities.ts).
  session_server_type: string | null
}

export interface ConfigRequest {
  credential: string
  url: string
  server_type: 'subsonic' | 'jellyfin' | 'plex'
  user_id?: string
  // Plex only — the server's own clientIdentifier (PlexServer.machine_identifier
  // below), needed for playlist writes. Ignored for Subsonic/Jellyfin.
  machine_identifier?: string
  username?: string
}

export interface JellyfinLoginRequest {
  url: string
  username: string
  password: string
}

export interface JellyfinLoginResponse {
  token: string
  user_id: string
}

export interface JellyfinQuickConnectInitiateRequest {
  url: string
}

export interface JellyfinQuickConnectInitiateResponse {
  secret: string
  code: string
}

export interface JellyfinQuickConnectConnectRequest {
  url: string
  secret: string
}

export interface JellyfinQuickConnectConnectResponse {
  authenticated: boolean
  // Only present once authenticated is true.
  token?: string
  user_id?: string
  username?: string
}

export interface PlexPinInitiateResponse {
  id: number
  code: string
  // Ready-built app.plex.tv/auth link — opened in the system browser (see
  // ServerLoginView.vue), not something the frontend needs to construct
  // itself.
  auth_url: string
}

export interface PlexPinCheckRequest {
  id: number
}

export interface PlexPinCheckResponse {
  authenticated: boolean
  // Both only present once authenticated is true. account_token is the
  // Plex *account* token, not yet a server-scoped one (see
  // PlexServer.token below). username is best-effort — a lookup failure
  // server-side leaves it as an empty string rather than failing the
  // whole login (see connect/routes/plex_auth.py).
  account_token?: string
  username?: string
}

export interface PlexResourcesRequest {
  account_token: string
}

export interface PlexServer {
  name: string
  machine_identifier: string
  url: string
  // Server-scoped token, distinct from the account token that listed it —
  // this is what gets sent to /config, same trust level as Jellyfin's own
  // AccessToken already flowing to the renderer.
  token: string
}

export interface PlexResourcesResponse {
  servers: PlexServer[]
}

export interface StatusTrack {
  id: string
  artist: string
  album: string
  cover_art_url: string | null
  duration: number
  title: string
}

export interface ConnectStatus {
  current_track: StatusTrack | null
  current_track_index: number
  elapsed: number
  ended: boolean
  paused: boolean
  radio: { title: string; url: string } | null
  streaming: boolean
  targets: ConnectDeviceRef[]
  total_tracks: number
  // True only on the single status tick right after a takeover displaced
  // this session from its target — see connect/core/session.py's
  // displace_target(). Tells playback.ts's cast-ended handler not to hand
  // playback off to local speakers, since the user didn't ask to stop
  // casting, another session just took the device.
  displaced: boolean
}

// One GET /visualizer frame — see connect/core/audio_analysis.py. Only ever
// arrives while casting to a target that route's should_analyze() allows
// (Sonos/DLNA/Chromecast, not AirPlay/radio); AudioVisualizer.vue's 'cast'
// mode is the only consumer.
export interface VisualizerFrame {
  bands: number[]
}

export interface PlayResponse {
  // 'superseded': the backend dropped this dispatch because a later one
  // (higher seq) already won — see routes/playback.py's play_lock/play_seq
  // and playback.ts's dispatchSeq. No stream_url in that case; callers don't
  // need to act on it, since whatever superseded this one already updated
  // state correctly.
  status: 'playing' | 'superseded'
  stream_url?: string
}

export interface PairingStartResponse {
  device_provides_pin: boolean
  name: string
}

/** One /lyrics/search candidate — isSync is only ever known for lrclib.net/
 * SimpMusic (NetEase's search API gives no such signal, so null there). */
export interface LyricSearchResult {
  artist: string
  id: string
  isSync: boolean | null
  name: string
  source: string
  score: number
  // Seconds, already normalized across sources (NetEase's own API gives
  // milliseconds — converted backend-side). Absent if a source's API
  // didn't return one for a given result.
  duration: number | null
}

/** /lyrics/auto's best-match result — `lyrics` is one raw string, LRC-
 * formatted when synced lyrics were found, otherwise plain text. Nothing on
 * this response says which — see services/lyrics/parseLrc.ts. */
export interface AutoLyricsResult {
  artist: string
  id: string
  lyrics: string
  name: string
  source: string
}
