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

/** How many entries a first load asks for, and how many each backwards
 * page holds. Mirrors connect's own _HISTORY_FIRST_PAGE/_HISTORY_MAX_PAGE,
 * and is what makes a shorter answer mean "that was the last of it" — see
 * fetchRadioTitleHistory(). */
export const RADIO_TITLE_PAGE_SIZE = 200

export interface RadioMetadata {
  /** Which station everything else in here describes — the backend's own
   * current station, which is not necessarily the one this device just
   * started: a relayed station only becomes current there once the player
   * has opened the new stream and the relay has connected to it, so a poll
   * in between is answered for the station before it. The caller compares
   * this against the station it is showing and drops what belongs to
   * another one (see stores/playback.ts's poll).
   *
   * null both while no station is current on the backend and when talking
   * to a connect too old to send it — which is why a mismatch, rather than
   * a missing match, is what a caller acts on. */
  url: string | null
  title: string | null
  /** What this station has played, newest first. Built by the backend
   * rather than accumulated here from these very answers: the poll runs
   * every 8s and only while pollGate.ts allows it at all, so a locally
   * kept log would have holes exactly where nobody was watching, and a
   * different set of them on every device.
   *
   * With a `since` this is only what is newer than the entry named, which
   * on almost every poll is nothing at all; without one it is the newest
   * RADIO_TITLE_PAGE_SIZE. Either way it is a piece of the backend's log,
   * never the whole of it. */
  history: RadioTitleEntry[]
  /** What the station itself declares it broadcasts at, in kbps, and what
   * it is encoded as ("MP3", "AAC", ...) — read once per connection out of
   * the stream's own ICY response headers, so both are null for a station
   * that declares nothing usable. Deliberately the station's own numbers
   * rather than anything Beacon re-encodes to while casting, so they read
   * the same on every device. StreamInfoSection.vue is the consumer. */
  bitrate: number | null
  codec: string | null
  /** What Beacon's own relay is handing this device, and why it is not
   * simply passing the station through: `relayReason` is null whenever it
   * is (the common case), and otherwise one of connect's REASON_* keys —
   * the same ones a cast stream reports. Both are null for a station
   * played straight from its own URL, which no relay touches. */
  relayBitrate: number | null
  relayReason: string | null
  /** The content type the relay is handing out — "audio/mpeg" or
   * "audio/aac". Reported rather than assumed: a local player can inherit
   * the relay a cast started, so even a format nobody chose on this device
   * can be the one arriving. */
  relayContentType: string | null
}

/** The watch's current title, what the station has played and what it
 * broadcasts, polled — see stores/playback.ts's own poll loop. `title` is
 * null both while nothing has been seen yet (the watch just started, or
 * the station has no ICY support at all) and once genuinely stopped;
 * callers don't need to tell those apart.
 *
 * `since` is the `at` of the newest entry the caller already holds, and
 * asks for nothing but what is newer. Omitting it means "I have none of
 * it", answered with the newest RADIO_TITLE_PAGE_SIZE. */
export async function fetchRadioMetadata(since?: number): Promise<RadioMetadata> {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`
  const response = await fetchConnect<RadioMetadata>(`/radio-metadata${query}`)
  const raw = response as RadioMetadata & {
    relay_bitrate?: number | null
    relay_reason?: string | null
    relay_content_type?: string | null
  }
  return {
    url: response.url ?? null,
    title: response.title ?? null,
    history: response.history ?? [],
    bitrate: response.bitrate ?? null,
    codec: response.codec ?? null,
    relayBitrate: raw.relay_bitrate ?? null,
    relayReason: raw.relay_reason ?? null,
    relayContentType: raw.relay_content_type ?? null,
  }
}

export interface RadioTitleHistoryPage {
  /** Same meaning as RadioMetadata.url, for the same reason. */
  url: string | null
  history: RadioTitleEntry[]
}

/** One page of entries older than `before` (the `at` of the oldest entry
 * the caller holds), newest first, and the station it is a page of — see
 * RadioMetadata.url for why a page has to name its own station.
 *
 * Fewer than RADIO_TITLE_PAGE_SIZE entries means the beginning of the log
 * has been reached. That is deliberately the only signal: a separate "has
 * more" flag is one more thing that can disagree with the list it
 * describes. */
export async function fetchRadioTitleHistory(before: number): Promise<RadioTitleHistoryPage> {
  const response = await fetchConnect<{ history: RadioTitleEntry[]; url?: string | null }>(
    `/radio-metadata/history?before=${encodeURIComponent(before)}&limit=${RADIO_TITLE_PAGE_SIZE}`,
  )
  return { url: response.url ?? null, history: response.history ?? [] }
}

/** The station's log searched by substring, newest match first — the whole
 * log the backend holds, not the pages this client happens to have pulled.
 * That is the point of it: what a reader can already see is what scrolling
 * would have found anyway.
 *
 * No cursor, unlike the paging call above. The backend caps a station's log
 * at 1000 entries and answers a search from all of it in one go (see
 * routes/radio.py), so what comes back is the whole result unless a station
 * really has played one title more than RADIO_TITLE_PAGE_SIZE times. */
export async function searchRadioTitleHistory(query: string): Promise<RadioTitleHistoryPage> {
  const response = await fetchConnect<{ history: RadioTitleEntry[]; url?: string | null }>(
    `/radio-metadata/history?q=${encodeURIComponent(query)}&limit=${RADIO_TITLE_PAGE_SIZE}`,
  )
  return { url: response.url ?? null, history: response.history ?? [] }
}
