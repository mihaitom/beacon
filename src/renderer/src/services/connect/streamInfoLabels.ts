/** The two lines that describe a cast stream: what is going out, and what
 * it was made from.
 *
 * Here rather than inside StreamInfoSection.vue because the phone remote
 * shows the same two lines in its own cast sheet (connect/static/remote/
 * js/devices.js, plain JS with no build step and no access to a component),
 * and it is handed them ready-made in the remote snapshot. A second
 * implementation over there would drift from this one the first time a
 * format is added.
 */
import type { ConnectStreamInfo } from './types'

// Every tier core/streamer.py's resolve_output_format() can produce. An
// unknown content type falls through to itself rather than to nothing.
export const TARGET_LABEL_FOR_CONTENT_TYPE: Record<string, string> = {
  'audio/flac': 'FLAC',
  'audio/mpeg': 'MP3',
  'audio/aac': 'AAC',
  // Reachable since Opus joined CAST_FORMATS: a Chromecast declares it
  // (see its PLAYABLE_CODECS), so a cast at that quality really does come
  // out as Ogg. Without this the row read "audio/ogg" at the listener.
  'audio/ogg': 'Opus',
}

/** e.g. 96000 -> "96 kHz", 44100 -> "44.1 kHz". Shared by both lines so a
 * resampled dispatch reads as one comparison ("96 kHz / 24-bit" ->
 * "48 kHz") rather than two differently-formatted numbers. */
export function formatKhz(hz: number): string {
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

/** What the speaker is being sent.
 *
 * The rate/depth are appended only where they were actually forced away
 * from the source's own (see ConnectStreamInfo.target_sample_rate) - that
 * is the case worth spelling out, since "FLAC" alone reads as an unchanged
 * copy of a FLAC source when it is really a downsampled one. */
export function castTargetLabel(info: ConnectStreamInfo): string {
  const base = TARGET_LABEL_FOR_CONTENT_TYPE[info.content_type] ?? info.content_type
  const changed = [
    info.target_sample_rate ? formatKhz(info.target_sample_rate) : null,
    info.target_bit_depth ? `${info.target_bit_depth}-bit` : null,
    info.target_bitrate_kbps ? `${info.target_bitrate_kbps} kb/s` : null,
  ].filter(Boolean)
  return changed.length > 0 ? `${base}, ${changed.join(' / ')}` : base
}

/** What it was made from - e.g. "FLAC, 96 kHz / 24-bit, 320 kb/s". Omits
 * whichever parts were not detected (see OutputFormat's own docstring on
 * why any of them can be null; lossless codecs in particular never report
 * a bitrate) rather than showing a misleading "unknown". null where even
 * the codec is unknown, which is the caller's cue to leave the row out. */
export function sourceLine(source: {
  source_codec: string | null
  source_sample_rate: number | null
  source_bit_depth: number | null
  source_bitrate_kbps: number | null
}): string | null {
  if (!source.source_codec) return null
  const parts = [source.source_codec.toUpperCase()]
  if (source.source_sample_rate) {
    const rate = formatKhz(source.source_sample_rate)
    parts.push(source.source_bit_depth ? `${rate} / ${source.source_bit_depth}-bit` : rate)
  }
  if (source.source_bitrate_kbps) parts.push(`${source.source_bitrate_kbps} kb/s`)
  return parts.join(', ')
}
