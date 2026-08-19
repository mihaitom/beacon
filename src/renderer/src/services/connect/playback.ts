import { fetchConnect } from './http'
import type { ConnectDeviceRef, PlayResponse } from './types'

interface PlayOptions {
  targets?: ConnectDeviceRef[]
  gain?: number
  startPosition?: number
  force?: boolean
  /** Upcoming song ids, NOT including `songId` itself — connect stores
   * the combined list (see connect/core/state.py's AppState.queue) and
   * auto-advances through it on its own when each song ends, so casting
   * keeps going even if the renderer that dispatched it is asleep/suspended
   * (see connect/routes/stream.py's _advance_or_end()). Omit (or pass [])
   * to opt out — e.g. repeat-one, where advancing at all would be wrong. */
  queue?: string[]
}

// Shared, strictly-increasing dispatch counter for /play and /play-url (both
// decide "what's current" for the connect session, so they share one
// sequence). The backend (routes/playback.py, SessionState.play_seq) drops
// any request whose seq is lower than one it's already accepted, so a
// slow-to-arrive-but-actually-older dispatch (rapid next/next, or a click
// while a previous switch is still in flight — see playback.ts's
// startCurrent()) can never end up as the one audibly playing just because
// its response happened to land last.
//
// Date.now() (wall-clock ms), not a simple per-device incrementing integer —
// this connect session can now be shared live by more than one device at
// once (a phone and the desktop app logged into the same account/server
// compute the same session id, see computeConnectSessionId()), each with
// its own independent localStorage. A phone logging in for the first time
// starts its own counter at 0/1 regardless of how far the desktop's had
// already climbed for that same session — its very first, genuinely-newest
// dispatch then read as "stale" (seq too low) purely from the mismatched
// starting point, not any real out-of-order arrival — exactly what got
// reported as "Ignoring superseded request (seq=7 < 33)" logging a phone's
// play tap being silently dropped. A real timestamp is directly comparable
// across independent devices (their clocks are, in the overwhelming common
// case, both roughly synced to real time) without needing to coordinate a
// shared counter between them at all.
//
// Still persisted in localStorage, for the same reason as before: the
// backend's own play_seq lives on the session and survives a frontend
// reload (HMR, window reload, ...) untouched, so this needs to pick back up
// from at least where it left off rather than restarting.
const DISPATCH_SEQ_KEY = 'beacon.dispatchSeq'
let dispatchSeq = Number(localStorage.getItem(DISPATCH_SEQ_KEY)) || 0

function nextSeq(): number {
  // max(), not a bare Date.now() — two dispatches from *this* device
  // landing in the same millisecond (back-to-back calls, no network delay
  // between them) still need to come out strictly increasing relative to
  // each other, same as the old counter guaranteed. Falls back to ticking
  // up by 1 only in that same-millisecond case; otherwise this is just the
  // current timestamp.
  dispatchSeq = Math.max(Date.now(), dispatchSeq + 1)
  localStorage.setItem(DISPATCH_SEQ_KEY, String(dispatchSeq))
  return dispatchSeq
}

export async function play(songId: string, options: PlayOptions = {}): Promise<PlayResponse> {
  return fetchConnect<PlayResponse>('/play', {
    method: 'POST',
    body: {
      song_ids: [songId, ...(options.queue ?? [])],
      targets: options.targets?.map((t) => ({ name: t.name, type: t.type })),
      gain: options.gain ?? 1.0,
      start_position: options.startPosition ?? 0,
      force: options.force ?? false,
      seq: nextSeq(),
    },
  })
}

export async function playUrl(
  url: string,
  title: string,
  options: { targets?: ConnectDeviceRef[]; force?: boolean } = {},
): Promise<void> {
  await fetchConnect('/play-url', {
    method: 'POST',
    body: {
      url,
      title,
      targets: options.targets?.map((t) => ({ name: t.name, type: t.type })),
      force: options.force ?? false,
      seq: nextSeq(),
    },
  })
}

export async function pause(): Promise<void> {
  await fetchConnect('/pause', { method: 'POST' })
}

export async function resume(): Promise<void> {
  await fetchConnect('/resume', { method: 'POST' })
}

export async function seek(position: number): Promise<void> {
  await fetchConnect('/seek', { method: 'POST', body: { position } })
}

export async function stop(): Promise<void> {
  await fetchConnect('/stop', { method: 'POST' })
}

/** Re-sends the upcoming queue (same convention as play()'s `queue` option —
 * NOT including the current song) after a queue edit made mid-play, so
 * connect's own auto-advance (routes/stream.py's _advance_or_end()) keeps
 * following it even once the renderer that dispatched it goes to sleep.
 * See stores/playback.ts's syncCastQueue(). */
export async function updateQueue(songIds: string[]): Promise<void> {
  await fetchConnect('/queue', { method: 'POST', body: { song_ids: songIds } })
}
