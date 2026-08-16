import { fetchConnect } from './http'
import type { ConnectDeviceRef, PlayResponse } from './types'

interface PlayOptions {
  targets?: ConnectDeviceRef[]
  gain?: number
  startPosition?: number
  force?: boolean
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
// Persisted in localStorage, not just an in-memory module variable — the
// backend's own play_seq lives on the session, which survives a frontend
// reload (HMR, window reload, ...) untouched. A bare `let dispatchSeq = 0`
// here would restart from 1 every reload while the backend still remembers
// wherever it left off, so every dispatch below that point got silently
// dropped as "superseded" until the reloaded counter climbed back past it
// — from the user's perspective, playback just stopped responding until
// enough clicks happened to catch back up. A single global counter (not
// scoped per session/server) is fine: it only ever needs to stay
// monotonically non-decreasing, and a value that's "too high" for the
// session currently in play is harmless — only "lower than what this
// session already saw" gets rejected.
const DISPATCH_SEQ_KEY = 'beacon.dispatchSeq'
let dispatchSeq = Number(localStorage.getItem(DISPATCH_SEQ_KEY)) || 0

function nextSeq(): number {
  dispatchSeq += 1
  localStorage.setItem(DISPATCH_SEQ_KEY, String(dispatchSeq))
  return dispatchSeq
}

export async function play(trackId: string, options: PlayOptions = {}): Promise<PlayResponse> {
  return fetchConnect<PlayResponse>('/play', {
    method: 'POST',
    body: {
      track_ids: [trackId],
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
