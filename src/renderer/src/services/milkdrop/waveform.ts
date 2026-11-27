/** A frame's base64 waveform (connect's waveform_snapshot) as the bytes
 * Butterchurn reads - the app's cast feed and the party guest page alike. */
export function decodeWaveform(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}
