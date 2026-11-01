/** Tells connect where this device's own playback is, so the room lights
 * can play along with it (connect/lights/controller.py). Casts need none
 * of this - connect plays those itself and knows where they are.
 *
 * Only the desktop app reports: it is in the house connect runs in more
 * often than not, while a phone in a browser may be listening on the way
 * to work and must not set the lights at home flashing.
 *
 * Reports go out when something changes (a song, play/pause, a seek) and
 * every few seconds while playing; connect carries the position forward
 * in between. */

import { watch } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { reportLocalPlayback, stopLocalReport } from '@/services/connect/lights'

// Well inside connect's LOCAL_REPORT_TTL (8 s), so one lost request does
// not stop the lights.
export const REPORT_INTERVAL_MS = 3_000
const TICK_MS = 500
// A position this far from where the last report puts it now is a seek.
const SEEK_THRESHOLD_SECONDS = 0.75

interface Reported {
  songId: string
  position: number
  playing: boolean
  at: number
}

let timer: ReturnType<typeof setInterval> | null = null
let stopWatching: (() => void) | null = null
let last: Reported | null = null

/** What should be reported right now, or null for nothing to follow. */
function current(): { songId: string; position: number; playing: boolean } | null {
  const playback = usePlaybackStore()
  if (playback.isCasting) return null
  if (playback.radioStation || playback.preview) return null
  const song = playback.currentSong
  if (!song) return null
  return { songId: song.id, position: playback.localPosition, playing: playback.isPlaying }
}

function needsReport(now: number, next: NonNullable<ReturnType<typeof current>>): boolean {
  if (!last) return true
  if (last.songId !== next.songId || last.playing !== next.playing) return true
  if (!next.playing) return false
  if (now - last.at >= REPORT_INTERVAL_MS) return true
  const expected = last.position + (now - last.at) / 1000
  return Math.abs(next.position - expected) > SEEK_THRESHOLD_SECONDS
}

async function tick(): Promise<void> {
  const now = Date.now()
  const next = current()
  if (!next) {
    if (last) {
      last = null
      await stopLocalReport().catch(() => {})
    }
    return
  }
  if (!needsReport(now, next)) return
  last = { ...next, at: now }
  try {
    await reportLocalPlayback(next.songId, next.position, next.playing)
  } catch {
    // connect away or no lights set up: the next change or interval tries
    // again.
  }
}

export function initLightsReport(): void {
  if (timer || !window.api) return
  timer = setInterval(() => void tick(), TICK_MS)
  const playback = usePlaybackStore()
  // Changes go out at once rather than on the next tick.
  stopWatching = watch(
    () => [playback.isCasting, playback.currentSong?.id, playback.isPlaying],
    () => void tick(),
  )
}

/** For tests. */
export function resetLightsReport(): void {
  if (timer) clearInterval(timer)
  timer = null
  stopWatching?.()
  stopWatching = null
  last = null
}

export const _test = { tick }
