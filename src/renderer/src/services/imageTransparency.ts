/**
 * Reads whether an image has meaningful transparency — used for radio
 * station favicons in NowPlayingView.vue, which skips the card-style
 * treatment (shadow, background box) real cover art gets for one that's
 * actually just a logo floating on transparency: boxing a transparent PNG
 * in a card designed for opaque album art looks like a broken image (the
 * app's own dark background showing through the "card" as a faint muddy
 * tint) rather than a clean logo.
 *
 * The actual detection happens server-side (see connect/routes/radio.py's
 * _has_transparency(), returned as the X-Has-Transparency response header)
 * — that backend already has the raw image bytes in hand with no CORS/
 * tainted-canvas considerations to work around, unlike sampling a <canvas>
 * from the renderer would.
 */
export async function hasTransparency(url: string): Promise<boolean> {
  try {
    const response = await fetch(url)
    return response.headers.get('X-Has-Transparency') === 'true'
  } catch {
    return false
  }
}
