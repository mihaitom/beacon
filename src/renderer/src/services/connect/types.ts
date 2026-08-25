export type DeviceType = 'sonos' | 'chromecast' | 'dlna' | 'airplay'

export interface ConnectDeviceRef {
  name: string
  type: DeviceType
}

// One entry of ConnectStatus.targets below — a ConnectDeviceRef plus
// whatever's currently known about its volume. Kept separate from
// ConnectDeviceRef itself (rather than adding these fields there) since
// that type is also used for staged/requested targets (the device picker,
// PlayRequest) where a volume reading doesn't apply at all.
export interface ConnectStatusTarget extends ConnectDeviceRef {
  // Optional as well as nullable: the backend always sends both (null until
  // something has actually reported a reading — an unclaimed device, or a
  // claimed one whose first reading, device-volume GET or a Sonos
  // RenderingControl push, hasn't landed yet — see connect/routes/upnp.py),
  // but plenty of test fixtures build a target literal from just
  // {name, type} without caring about volume at all; optional lets those
  // keep doing that instead of needing `volume: null, muted: null` padding
  // everywhere. Only ever populated for Sonos today; chromecast/dlna stay
  // unset here and keep DeviceListItem.vue's existing poll as their only
  // source.
  volume?: number | null
  muted?: boolean | null
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
  in_use_by_song?: string | null
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

export interface StatusSong {
  id: string
  artist: string
  album: string
  cover_art_url: string | null
  duration: number
  title: string
}

// What the backend is actually doing with the current/last-dispatched
// track's audio — see connect/core/streamer.py's OutputFormat and
// resolve_output_format(). Always present (even with nothing ever
// dispatched, it reflects the fallback default) so components can read it
// unconditionally; StreamInfoSection.vue only renders while actually
// casting (see ConnectDevicePicker.vue's own v-if).
export interface ConnectStreamInfo {
  // e.g. "flac (copy)", "flac → flac (resampled for device limit)",
  // "mp3-192k (fallback)" — see resolve_output_format()'s own tiers. Not
  // shown verbatim in the UI (too technical for a casual glance) — used
  // only to derive `transcoding` backend-side.
  label: string
  content_type: string
  // Derived backend-side from `label` (every copy-tier label ends in
  // "(copy)", nothing else does) rather than left for the frontend to
  // pattern-match the label text itself.
  transcoding: boolean
  // The probed source's own numbers — null when nothing has been probed
  // (the fallback default) or when a probe's result was discarded (the
  // ReplayGain-forced-fallback path). Never the *output* format's numbers;
  // for a resampled dispatch this is deliberately the source's original
  // rate/depth, not the capped one, so "96kHz, resampled for this device"
  // can be shown instead of hiding the resample happened. bitrate_kbps is
  // null for lossless codecs (they don't report one) as well as whenever
  // nothing was probed.
  source_codec: string | null
  source_sample_rate: number | null
  source_bit_depth: number | null
  source_bitrate_kbps: number | null
  // The output's own numbers, but *only* where they're forced away from
  // the source's (the resampled tiers) — null everywhere else, including
  // every tier that simply keeps whatever the source had. So a non-null
  // value here always means "this specific number changed on the way to
  // the device", which is exactly what's worth showing.
  target_sample_rate: number | null
  target_bit_depth: number | null
  // Why this track is being transcoded, as a stable key (see
  // connect/core/streamer.py's REASON_* constants) that
  // StreamInfoSection.vue turns into a translated sentence. null on the
  // copy tier, which isn't transcoding, and on the shared fallback default
  // that was never resolved for a particular track.
  transcode_reason: string | null
  // How many cast devices currently have the stream open — 0 while paused
  // or between tracks is normal, not itself a health problem.
  active_connections: number
  // Worst event-loop stall in the last 30s, in seconds — process-wide, see
  // connect/core/loop_health.py. 0 is healthy; anything approaching 1s+ is
  // what a real drop looks like building up to.
  loop_lag: number
}

export interface ConnectStatus {
  current_song: StatusSong | null
  stream_info: ConnectStreamInfo
  // Full queue (already-played history included, not just what's left) and
  // where current_song sits in it — see connect/core/state.py's
  // AppState.queue. Lets every client controlling this session mirror the
  // same queue/now-playing in its own UI, not just whichever one dispatched
  // it — see stores/playback.ts's queue-adoption logic in its
  // connect.$subscribe() handler.
  queue: string[]
  current_song_index: number
  // Standing shuffle/repeat preferences and the unshuffled reference order
  // `queue` was built from — see AppState.shuffle/repeat_mode/
  // original_queue's comments. original_queue matters together with
  // shuffle: it's what stores/playback.ts's toggleShuffle() reverts `queue`
  // to when switching shuffle off, so every client needs the same one, not
  // just the same on/off flag.
  original_queue: string[]
  shuffle: boolean
  repeat_mode: 'off' | 'all' | 'one'
  elapsed: number
  ended: boolean
  paused: boolean
  radio: { title: string; url: string } | null
  streaming: boolean
  targets: ConnectStatusTarget[]
  total_songs: number
  // True only on the single status tick right after a takeover displaced
  // this session from its target — see connect/core/session.py's
  // displace_target(). Tells playback.ts's cast-ended handler not to hand
  // playback off to local speakers, since the user didn't ask to stop
  // casting, another session just took the device.
  displaced: boolean
  // True only on the single status tick fired when a cast device dropped its
  // connection and never came back — see connect/routes/stream.py's
  // _mark_disconnected_if_not_reconnected(). Distinct from `displaced`: this
  // one means nobody asked for the stop at all, which is why the frontend
  // offers to pick playback back up rather than deciding for the user.
  interrupted: boolean
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

/** POST /queue's response — same `superseded` convention as PlayResponse
 * (see routes/playback.py's /queue, sharing session.play_seq's ordering). */
export interface QueueResponse {
  status: 'ok' | 'superseded'
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
