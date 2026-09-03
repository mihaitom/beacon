/** Decoded by hand (not `await (await fetch(dataUrl)).blob()`) so this never
 * touches the global fetch — a `data:` URL isn't a real network request, and
 * routing it through fetch anyway would make every batched image show up as
 * a second, synthetic "request" to anything (including a test) that observes
 * fetch calls to account for network activity.
 *
 * Shared by the two batch endpoints that answer with base64 JSON rather than
 * binary — cover art (coverArtBatch.ts) and radio station logos
 * (radioFaviconBatch.ts). Both made that trade for the same reason: one
 * plain object every caller already knows how to parse, at ~33% more bytes
 * than raw binary, which is a fine price for thumbnail-sized images. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, commaIndex)
  const mime = /data:(.*?);base64/.exec(header)?.[1] ?? 'application/octet-stream'
  const binary = atob(dataUrl.slice(commaIndex + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
