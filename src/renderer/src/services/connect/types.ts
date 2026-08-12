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
}

export interface ConfigRequest {
  credential: string
  url: string
  server_type: 'subsonic' | 'jellyfin'
  user_id?: string
  username?: string
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
}

export interface PlayResponse {
  status: 'playing'
  stream_url: string
}

export interface PairingStartResponse {
  device_provides_pin: boolean
  name: string
}
