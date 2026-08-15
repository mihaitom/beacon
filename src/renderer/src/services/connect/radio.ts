/** Builds the URL for GET /radio-favicon (connect/routes/radio.py) — an
 * <img src> value, so auth travels as a query param, not a header (see
 * connect/core/auth.py's require_token, same reasoning as coverArtUrl/
 * streamUrl in services/subsonic/client.ts).
 *
 * `minSize` picks which "quality level" comes back, when the station's
 * homepage actually declares more than one (see routes/radio.py's
 * _select()) — smaller for the compact radio list row, larger for
 * PlayerBar/NowPlayingView, so a low-res favicon.ico icon never has to be
 * stretched up to fill a much bigger spot than it was ever meant for. */
export function radioFaviconUrl(
  apiUrl: string,
  token: string,
  homePageUrl: string,
  minSize = 0,
): string {
  const params = new URLSearchParams({ url: homePageUrl })
  if (minSize > 0) params.set('min_size', String(minSize))
  if (token) params.set('token', token)
  return `${apiUrl}/radio-favicon?${params.toString()}`
}
