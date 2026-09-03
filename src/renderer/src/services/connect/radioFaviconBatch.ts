import { fetchConnect } from './http'
import { dataUrlToBlob } from './dataUrl'
import { radioFaviconKey, type RadioFaviconRequest } from './radio'

/** One station's resolved logo. `transparent` is the backend's own reading
 * of the image (connect/routes/radio.py's _has_transparency), carried in
 * the same answer as the bytes — NowPlayingView.vue drops the card
 * treatment for a logo floating on transparency, and used to learn that
 * from a *second* request against the same URL just to read one response
 * header. */
export interface RadioFavicon {
  blob: Blob
  transparent: boolean
}

interface BatchEntry {
  data_url: string
  transparent: boolean
}

interface RadioFaviconBatchResponse {
  results: Record<string, BatchEntry | null>
  pending: string[]
}

// Same 20ms grouping window as coverArtBatch.ts, for the same reason: short
// enough to stay invisible, long enough that everything one view's opening
// frame asks for lands in a single request.
//
// What that is worth here is larger than it is for cover art. A radio list
// renders one logo per station, each under its own one-off URL carrying
// that station's homepage — fifty of those in the second a view opens is
// fifty distinct paths from one IP, which is exactly what a probe/crawl
// detector counts. It got a real user's own IP banned by CrowdSec after
// RADIO_FAVICON_CACHE_VERSION was raised and every previously cached logo
// turned into a miss at once. See connect/routes/radio.py's
// _NEGATIVE_CACHE_CONTROL for the other half of that fix.
const BATCH_WINDOW_MS = 20

// Mirrors _MAX_BATCH_STATIONS in connect/routes/radio.py — the server drops
// the tail of anything longer, so it is split here rather than silently
// truncated there.
const MAX_BATCH_SIZE = 200

// How long to wait before asking again for a station the backend answered
// `pending` for — it did not finish that lookup inside its own deadline,
// but it kept working on it, so the next ask is normally a cache hit rather
// than a repeat of the work. Backing off rather than fixed, and bounded:
// past the last of these the request fails as transient, and CoverArt.vue's
// own retry budget (RETRY_DELAYS_MS) is the outer net.
const PENDING_RETRY_MS = [800, 2000, 5000]

// How many resolved logos to keep in memory. Small on purpose: it exists so
// that the second and third *view* of the same playing station (PlayerBar,
// Home's hero, Now Playing) costs nothing, not as a general image cache —
// the browser's own HTTP cache and the backend's _result_cache are what
// make repeat visits cheap. A station with no logo is remembered too, and
// costs nothing to keep, so nothing re-asks for an answer that was already
// "there isn't one".
const MAX_RESOLVED = 32

interface PendingRequest {
  resolve: (favicon: RadioFavicon) => void
  reject: (reason: unknown) => void
}

interface QueuedStation {
  request: RadioFaviconRequest
  waiting: PendingRequest[]
  /** How many times this station has come back `pending` — indexes
   * PENDING_RETRY_MS, and being past its end is what stops the asking. */
  attempts: number
}

let queued = new Map<string, QueuedStation>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
const resolved = new Map<string, RadioFavicon | null>()

/** Resolves to the station's logo, or rejects — with a DOMException named
 * 'AbortError' if `signal` fires first, a NoRadioFaviconError if the
 * station genuinely has no findable logo, and a plain Error for anything
 * that might work later. Mirrors fetchCoverArtBatched()'s contract, since
 * both are consumed by the same loadCandidates() in CoverArt.vue. */
export function fetchRadioFaviconBatched(
  request: RadioFaviconRequest,
  signal: AbortSignal,
): Promise<RadioFavicon> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const key = radioFaviconKey(request)
    if (resolved.has(key)) {
      const hit = resolved.get(key)!
      if (hit) resolve(hit)
      else reject(new NoRadioFaviconError())
      return
    }

    let station = queued.get(key)
    if (!station) {
      station = { request, waiting: [], attempts: 0 }
      queued.set(key, station)
    }
    const pending: PendingRequest = { resolve, reject }
    station.waiting.push(pending)

    signal.addEventListener(
      'abort',
      () => {
        const at = station!.waiting.indexOf(pending)
        if (at >= 0) station!.waiting.splice(at, 1)
        // Nobody left waiting on this station — drop it from the batch
        // entirely, so a flush that hasn't happened yet never asks for it
        // at all rather than asking and discarding the answer.
        if (station!.waiting.length === 0) queued.delete(key)
        reject(abortError())
      },
      { once: true },
    )

    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS)
  })
}

/** The station has no findable logo — a settled answer, not a failure to
 * retry. Named so CoverArt.vue can tell it apart from a backend that was
 * simply unreachable just now. */
export class NoRadioFaviconError extends Error {
  constructor() {
    super('No favicon for this station')
    this.name = 'NoRadioFaviconError'
  }
}

function abortError(): DOMException {
  return new DOMException('The radio favicon request was aborted', 'AbortError')
}

function flush(): void {
  flushTimer = null
  const batch = [...queued.values()]
  queued = new Map()
  for (let offset = 0; offset < batch.length; offset += MAX_BATCH_SIZE) {
    void sendBatch(batch.slice(offset, offset + MAX_BATCH_SIZE))
  }
}

async function sendBatch(stations: QueuedStation[]): Promise<void> {
  const byKey = new Map(stations.map((station) => [radioFaviconKey(station.request), station]))
  let response: RadioFaviconBatchResponse
  try {
    response = await fetchConnect<RadioFaviconBatchResponse>('/radio-favicon/batch', {
      method: 'POST',
      body: {
        stations: stations.map((station) => ({
          key: radioFaviconKey(station.request),
          url: station.request.homePageUrl,
          hint: station.request.hint,
          min_size: station.request.minSize,
        })),
      },
    })
  } catch (error) {
    for (const station of stations) settle(station, null, error)
    return
  }

  for (const [key, entry] of Object.entries(response.results)) {
    const station = byKey.get(key)
    if (!station) continue
    byKey.delete(key)
    if (!entry) {
      remember(key, null)
      settle(station, null, new NoRadioFaviconError())
      continue
    }
    try {
      const favicon = { blob: dataUrlToBlob(entry.data_url), transparent: entry.transparent }
      remember(key, favicon)
      settle(station, favicon, undefined)
    } catch (error) {
      settle(station, null, error)
    }
  }

  for (const key of response.pending) {
    const station = byKey.get(key)
    if (!station) continue
    byKey.delete(key)
    const delay = PENDING_RETRY_MS[station.attempts]
    if (delay === undefined) {
      settle(station, null, new Error('Station logo is still being resolved'))
      continue
    }
    station.attempts += 1
    setTimeout(() => {
      // Everyone who wanted it gave up while this was backing off (the row
      // scrolled away, the station changed) — asking again would be a
      // request for an answer with nowhere to go.
      if (station.waiting.length > 0) void sendBatch([station])
    }, delay)
  }

  // Neither answered nor deferred — a malformed reply rather than anything
  // this station did. Failing them transiently is what keeps a caller from
  // waiting on a promise nothing will ever settle.
  for (const station of byKey.values()) {
    settle(station, null, new Error('Station logo missing from the batch answer'))
  }
}

function remember(key: string, favicon: RadioFavicon | null): void {
  resolved.delete(key)
  resolved.set(key, favicon)
  while (resolved.size > MAX_RESOLVED) {
    const oldest = resolved.keys().next().value
    if (oldest === undefined) break
    resolved.delete(oldest)
  }
}

function settle(station: QueuedStation, favicon: RadioFavicon | null, error: unknown): void {
  for (const pending of station.waiting) {
    if (favicon) pending.resolve(favicon)
    else pending.reject(error)
  }
  station.waiting = []
}

/** Test seam — the module-level caches outlive any one component, so a test
 * that doesn't clear them is answered by the previous one's fixtures. */
export function _resetRadioFaviconBatch(): void {
  queued = new Map()
  resolved.clear()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
}
