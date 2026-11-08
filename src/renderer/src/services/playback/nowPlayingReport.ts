/** Tells connect what this device plays by itself, for the account's own apps
 * (routes/now_playing.py). A cast from a browser is left out, since connect
 * knows that one already. The desktop app's connect is a different one from
 * the server's, so the desktop reports its casts too.
 *
 * One request per song for an account with no such app: the answer says
 * nobody is listening, and that holds until the next song. */

import { watch } from 'vue'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import {
  reportNowPlaying,
  stopNowPlayingReport,
  type NowPlayingReport,
} from '@/services/connect/nowPlaying'

// Well inside connect's 90 seconds, so that one lost request changes nothing.
export const HEARTBEAT_MS = 30_000
const TICK_MS = 1_000
const SEEK_THRESHOLD_SECONDS = 2

let timer: ReturnType<typeof setInterval> | null = null
let stopWatching: (() => void) | null = null
let last: { report: NowPlayingReport; identity: string; at: number } | null = null
/** What an answer of "nobody wants this" was about. */
let unwantedIdentity: string | null = null
/** Which report is the newest: ticks overlap, and an answer about the song
 * before says nothing about this one. */
let newestReport = 0

function currentReport(): NowPlayingReport | null {
  const playback = usePlaybackStore()
  if (playback.preview || (playback.isCasting && !window.api)) return null
  const devices = playback.isCasting ? useConnectStore().activeTargets.map((t) => t.name) : []
  const paused = !playback.isPlaying
  if (playback.radioStation) {
    return {
      song: null,
      radio: {
        station: playback.radioStation.name,
        title: useRadioMetadataStore().nowPlaying,
      },
      position: null,
      paused,
      devices,
    }
  }
  const song = playback.currentSong
  if (!song) return null
  return {
    song: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      cover_art_id: song.coverArtId ?? '',
    },
    radio: null,
    position: playback.localPosition,
    paused,
    devices,
  }
}

function identityOf(report: NowPlayingReport): string {
  return report.song ? `song:${report.song.id}` : `radio:${report.radio?.station}`
}

function changed(now: number, report: NowPlayingReport, identity: string): boolean {
  if (!last || last.identity !== identity) return true
  if (last.report.paused !== report.paused) return true
  if (last.report.radio?.title !== report.radio?.title) return true
  if (last.report.devices.join() !== report.devices.join()) return true
  if (now - last.at >= HEARTBEAT_MS) return true
  if (report.paused || report.position === null || last.report.position === null) return false
  const expected = last.report.position + (now - last.at) / 1000
  return Math.abs(report.position - expected) > SEEK_THRESHOLD_SECONDS
}

async function tick(): Promise<void> {
  const report = currentReport()
  if (!report) {
    unwantedIdentity = null
    newestReport++
    if (last) {
      last = null
      await stopNowPlayingReport().catch(() => {})
    }
    return
  }
  const identity = identityOf(report)
  if (identity === unwantedIdentity) return
  unwantedIdentity = null
  const now = Date.now()
  if (!changed(now, report, identity)) return
  last = { report, identity, at: now }
  const thisReport = ++newestReport
  try {
    const wanted = await reportNowPlaying(report)
    if (!wanted && thisReport === newestReport) {
      unwantedIdentity = identity
      last = null
    }
  } catch {
    // connect away: the next change or heartbeat tries again.
  }
}

export function initNowPlayingReport(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  const playback = usePlaybackStore()
  // Changes go out at once rather than on the next tick.
  stopWatching = watch(
    () => [playback.isCasting, playback.currentSong?.id, playback.radioStation, playback.isPlaying],
    () => void tick(),
  )
}

/** For tests. */
export function resetNowPlayingReport(): void {
  if (timer) clearInterval(timer)
  timer = null
  stopWatching?.()
  stopWatching = null
  last = null
  unwantedIdentity = null
}

export const _test = { tick }
