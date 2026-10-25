import { fetchConnect } from './http'

// How the cast stream reaches each of its devices right now - connect's
// core/stream_diagnostics.py, shown by CastStreamDebugOverlay.vue while the
// log level is DEBUG. Seconds and ages are as connect measured them at the
// moment it answered.

export interface StreamConnectionInfo {
  /** Of the stream now playing, not an earlier seek or track. */
  current: boolean
  open: boolean
  outcome: string | null
  age: number
  /** A Sonos's model number ("S3"), null for anything else. */
  model: string | null
  start: number
  bytes: number
  last_read: number
  /** Where in the track the audio taken so far ends. */
  audio_end: number | null
}

export interface StreamRequestInfo {
  ago: number
  method: string
  model: string | null
  range: string | null
  icy: string | null
  /** Set when the request was turned away ("204, stopped"). */
  answer: string | null
}

export interface StreamTargetInfo {
  /** null for an address that asked for the stream but is no target. */
  type: string | null
  name: string
  /** The Sonos this one plays through as a group follower. */
  follows: string | null
  state: string | null
  state_age: number | null
  problem: string | null
  problem_age: number | null
  /** Its newest connection, preferring one of the stream now playing. */
  connection: StreamConnectionInfo | null
  /** Only for the one target whose position is read. */
  device: { position: number; age: number } | null
  /** Seconds of audio sent beyond where the device is now. */
  ahead: number | null
  /** Newest first. */
  requests: StreamRequestInfo[]
}

export interface StreamDiagnostics {
  position: number | null
  track_end: number | null
  targets: StreamTargetInfo[]
}

export async function getStreamDiagnostics(): Promise<StreamDiagnostics> {
  return fetchConnect<StreamDiagnostics>('/stream-diagnostics')
}
