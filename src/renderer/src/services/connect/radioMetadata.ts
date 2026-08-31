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

interface RadioMetadataResponse {
  title: string | null
}

/** The watch's current title, polled — see stores/playback.ts's own poll
 * loop. Resolves to null both while nothing has been seen yet (the watch
 * just started, or the station has no ICY support at all) and once
 * genuinely stopped; callers don't need to tell those apart. */
export async function fetchRadioMetadata(): Promise<string | null> {
  const response = await fetchConnect<RadioMetadataResponse>('/radio-metadata')
  return response.title
}
