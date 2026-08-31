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
export function radioFaviconUrl(
  apiUrl: string,
  token: string,
  homePageUrl: string,
  minSize = 0,
  hint = '',
): string {
  const params = new URLSearchParams()
  if (homePageUrl) params.set('url', homePageUrl)
  if (minSize > 0) params.set('min_size', String(minSize))
  if (hint) params.set('hint', hint)
  if (token) params.set('token', token)
  return `${apiUrl}/radio-favicon?${params.toString()}`
}
