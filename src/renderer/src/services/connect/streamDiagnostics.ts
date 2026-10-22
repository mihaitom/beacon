import { fetchConnect } from './http'

// How the cast stream reaches its device right now - connect's
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
  /** An older Sonos's mode: 'whole' | 'paced' | 'file', else null. */
  mode: string | null
  /** "first-last/total" of a file's byte range. */
  range: string | null
  start: number
  bytes: number
  last_read: number
  /** Where in the track the audio taken so far ends. */
  audio_end: number | null
}

export interface StreamTargetInfo {
  type: string
  name: string
  state: string | null
  state_age: number | null
  problem: string | null
  problem_age: number | null
}

export interface StreamRequestInfo {
  ago: number
  method: string
  model: string | null
  range: string | null
  icy: string | null
}

export interface StreamDiagnostics {
  older_sonos_mode: string
  position: number | null
  track_end: number | null
  connections: StreamConnectionInfo[]
  device: { position: number; age: number } | null
  /** Seconds of audio sent beyond where the device is now. */
  ahead: number | null
  targets: StreamTargetInfo[]
  requests: StreamRequestInfo[]
}

export async function getStreamDiagnostics(): Promise<StreamDiagnostics> {
  return fetchConnect<StreamDiagnostics>('/stream-diagnostics')
}
