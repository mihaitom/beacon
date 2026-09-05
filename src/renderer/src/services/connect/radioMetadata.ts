import { fetchConnect } from './http'

/** Starts (or, for a different URL, restarts) this session's ICY "now
 * playing" watch on the connect backend for `url` — see
 * core/icy_metadata.py's own docstring for why a plain HTML5 `<audio>`
 * element can never surface this itself. Called for every radio play,
 * local playback included (see stores/playback.ts's own call sites): local
 * playback never otherwise touches this backend at all, unlike casting,
 * which already does through /play-url.
 *
 * Fire-and-forget like registerRadioBrowserClick() — a station with no ICY
 * support, or a request that fails outright, just means no now-playing text
 * ever shows up, never a reason to interrupt or retry the actual playback
 * this is riding along with. */
export function startRadioMetadataWatch(url: string): void {
  void fetchConnect('/radio-metadata/start', { method: 'POST', body: { url } }).catch(() => {})
}

/** Stops this session's watch — called wherever radio playback itself
 * stops, so a stale title from the last station doesn't linger for the
 * next poll to pick up before its own watch has even connected. */
export function stopRadioMetadataWatch(): void {
  void fetchConnect('/radio-metadata/stop', { method: 'POST' }).catch(() => {})
}

/** One title this station has played, with the wall-clock time (epoch
 * seconds) it arrived — a time of day is what the reader is after, and it
 * may well be read on a different device than the one that was playing. */
export interface RadioTitleEntry {
  title: string
  at: number
}

export interface RadioMetadata {
  title: string | null
  /** Everything this station has played this session, newest first. Built
   * by the backend rather than accumulated here from these very answers:
   * the poll runs every 8s and only while pollGate.ts allows it at all, so
   * a locally-kept log would have holes exactly where nobody was watching,
   * and a different set of them on every device. */
  history: RadioTitleEntry[]
  /** What the station itself declares it broadcasts at, in kbps, and what
   * it is encoded as ("MP3", "AAC", ...) — read once per connection out of
   * the stream's own ICY response headers, so both are null for a station
   * that declares nothing usable. Deliberately the station's own numbers
   * rather than anything Beacon re-encodes to while casting, so they read
   * the same on every device. StreamInfoSection.vue is the consumer. */
  bitrate: number | null
  codec: string | null
}

/** The watch's current title, the station's log and what it broadcasts,
 * polled — see stores/playback.ts's own poll loop. `title` is null both
 * while nothing has been seen yet (the watch just started, or the station
 * has no ICY support at all) and once genuinely stopped; callers don't
 * need to tell those apart. */
export async function fetchRadioMetadata(): Promise<RadioMetadata> {
  const response = await fetchConnect<RadioMetadata>('/radio-metadata')
  return {
    title: response.title ?? null,
    history: response.history ?? [],
    bitrate: response.bitrate ?? null,
    codec: response.codec ?? null,
  }
}
