import { fetchConnect } from './http'

/** Builds the URL for GET /radio-favicon (connect/routes/radio.py) — an
 * <img src> value, so auth travels as a query param, not a header (see
 * connect/core/auth.py's require_token, same reasoning as coverArtUrl/
 * streamUrl in services/subsonic/client.ts).
 *
 * `minSize` picks which "quality level" comes back, when the station's
 * homepage actually declares more than one (see routes/radio.py's
 * _select()) — smaller for the compact radio list row, larger for
 * PlayerBar/NowPlayingView, so a low-res favicon.ico icon never has to be
 * stretched up to fill a much bigger spot than it was ever meant for.
 *
 * `hint` is Radio Browser's own `favicon` field (RadioBrowserStation.favicon
 * in services/connect/radioBrowser.ts) — passed through unchanged for the
 * backend to try before it scrapes `homePageUrl` itself (see
 * routes/radio.py's own comment on why that's still routed through here
 * rather than used as an <img src> directly). Nothing to pass for a
 * station added by hand, which never had one in the first place.
 *
 * `homePageUrl` itself is optional here — a station played straight out of
 * the discover dialog without being added can have a `hint` but no
 * homepage at all (see RadioStation.favicon's own comment); the backend
 * tries `hint` before it ever needs a homepage to scrape. Call this at all
 * only once at least one of the two is present — see the callers' own
 * guards. */
/** Bumped to walk away from cache entries a previous version of this app
 * left behind. It is part of the URL, so raising it gives every station's
 * logo a cache key nothing has stored yet.
 *
 * Why it was needed once: /radio-favicon is cached for a week, and its
 * response only carries Access-Control-Allow-Origin when the request had
 * an Origin. It did not send `Vary: Origin` alongside, so a fetch without
 * one (an <img src>, a non-browser client) left a cacheable entry with no
 * CORS headers that the browser was then entitled to hand to this app's
 * own fetch() — which rejects it as "No 'Access-Control-Allow-Origin'
 * header is present", with no request going out at all. The backend now
 * always sends Vary (see _favicon_response in connect/routes/radio.py),
 * but that only governs entries stored from now on: anyone who already
 * had a poisoned one would have kept a blank station logo for up to a
 * week, through restarts, with nothing in the app able to fix it. Raise
 * this only for that kind of reason — a new value throws away every
 * user's correctly cached logos too. */
export const RADIO_FAVICON_CACHE_VERSION = '2'

/** The only sizes actually asked for, whatever a caller passes.
 *
 * min_size is part of the answer's identity — in the browser's cache, in
 * the backend's own (routes/radio.py's _result_cache) and in the batch
 * endpoint's grouping — so every distinct value a caller invents is another
 * separate lookup and another separate cached copy of one station's logo.
 * The callers' natural sizes are 32 (RadioView's list row), 48 (the browse
 * dialog), 96 (PlayerBar/Home) and 512 (NowPlayingView): four keys for
 * what is, at most, two genuinely different images.
 *
 * Rounding *up* to the next step keeps that from costing anything visible —
 * an icon is only ever displayed smaller than it was asked for. The pairing
 * is deliberate rather than even: 96 shares the large step with 512 because
 * PlayerBar and NowPlayingView show the *same* station at the same time, so
 * one shared entry there is a request saved rather than a bigger download
 * for nothing. */
const FAVICON_SIZE_STEPS = [64, 512]

export function faviconSizeStep(minSize: number): number {
  // 0 means "whatever you find" and is not a size to round up — asking for
  // 64 instead would make the backend keep looking past the first usable
  // icon for a caller that said it did not care.
  if (minSize <= 0) return 0
  return FAVICON_SIZE_STEPS.find((step) => step >= minSize) ?? minSize
}

/** Everything the backend needs to resolve one station's logo. The shape
 * fetchRadioFaviconBatched() takes (radioFaviconBatch.ts) and what
 * radioFaviconKey() identifies a station by. */
export interface RadioFaviconRequest {
  homePageUrl: string
  hint: string
  minSize: number
}

export function radioFaviconRequest(
  homePageUrl: string,
  minSize = 0,
  hint = '',
): RadioFaviconRequest {
  return { homePageUrl, hint, minSize: faviconSizeStep(minSize) }
}

/** Identifies one resolved logo. Carries the cache version for the same
 * reason the URL does — an in-memory entry from before a bump is as stale
 * as a stored one. */
export function radioFaviconKey(request: RadioFaviconRequest): string {
  return [RADIO_FAVICON_CACHE_VERSION, request.minSize, request.homePageUrl, request.hint].join(
    '\u0000',
  )
}

/** The single-icon URL. Still the right shape for anything that can only
 * hand a URL to an <img> and has no batching available to it — the phone's
 * remote-control UI (services/remoteControl/commands.ts) — but the app's
 * own views go through fetchRadioFaviconBatched() instead: a radio list
 * renders one of these per station, and fifty distinct URLs in the second
 * a view opens is the request shape that got a real user's IP banned. */
export function radioFaviconUrl(
  apiUrl: string,
  token: string,
  homePageUrl: string,
  minSize = 0,
  hint = '',
): string {
  const params = new URLSearchParams()
  if (homePageUrl) params.set('url', homePageUrl)
  const step = faviconSizeStep(minSize)
  if (step > 0) params.set('min_size', String(step))
  if (hint) params.set('hint', hint)
  if (token) params.set('token', token)
  params.set('v', RADIO_FAVICON_CACHE_VERSION)
  return `${apiUrl}/radio-favicon?${params.toString()}`
}

/** The playable audio URL behind a station's own stream URL.
 *
 * A great many stations are published as a .m3u or .pls: a text file
 * naming where the audio actually is, which no player can do anything
 * with (see connect/core/playlist_url.py). This asks the backend to look
 * inside one — it can't be done here, since the playlist sits on the
 * station's own host with no CORS allowance for this app, the same reason
 * radioFaviconUrl() exists.
 *
 * Only for *local* playback: casting resolves this inside /play-url
 * itself, on the same backend that has to hand the URL to a device. The
 * `looksLikePlaylist` guard is what keeps the overwhelmingly common case
 * (a real stream URL) from paying a round trip to be told nothing
 * changed.
 *
 * Never rejects: a playlist that can't be read resolves to the URL that
 * went in, leaving playback exactly where it would have been without
 * asking. */
export async function resolveRadioStreamUrl(url: string): Promise<string> {
  if (!looksLikePlaylist(url)) return url
  try {
    const result = await fetchConnect<{ url: string }>(
      `/radio-stream-url?url=${encodeURIComponent(url)}`,
    )
    return result.url || url
  } catch {
    return url
  }
}

/** Matched on the path alone, so a query string (a cache-buster, an auth
 * token) can neither trigger nor mask this. `.m3u8` is deliberately not
 * here: an HLS playlist looks superficially like an M3U but is the live
 * format itself, not an indirection to resolve away — see
 * connect/core/playlist_url.py's own list. */
function looksLikePlaylist(url: string): boolean {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? ''
  return ['.m3u', '.pls', '.asx', '.xspf'].some((extension) => path.endsWith(extension))
}
