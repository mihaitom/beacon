/**
 * The listener's audio-quality preferences, for their own player and for
 * casting — the visible replacement for connect's old FORCE_FALLBACK_FORMAT
 * environment variable, which forced mp3 192k on everything and needed a
 * container restart to change.
 *
 * Both are **ceilings**, not instructions: naming a format caps what gets
 * sent, and a source that already fits under it is left exactly as it was.
 * Converting a 128 kbps MP3 to "MP3 320" would re-encode it — losing
 * quality — and hand over a *larger* file than the original, which is the
 * opposite of everything either setting is for.
 *
 * Two of them rather than one, because they cap different paths and are
 * applied in different places:
 *
 * - `local` caps what this device's own `<audio>` element fetches, decided
 *   here (see plan()) because only the client knows which URL it is about
 *   to play. Stored per device, since the phone on a mobile connection and
 *   the desktop on the LAN have no reason to agree.
 * - `cast` caps what connect sends to a speaker, decided there (see
 *   _exceeds_quality_ceiling() in core/streamer.py) on top of the tier it
 *   would have picked anyway, and with each device's own format limits
 *   still winning over both.
 */

import { accountScopedKey } from '@/services/accountKey'

export type StreamFormat = 'original' | 'mp3' | 'aac' | 'opus'

/** The formats that actually name an encoder — i.e. everything except
 * "leave it alone". connect's own request field is typed the same way
 * (routes/playback.py's PlayRequest), so a value that can't be encoded
 * can't be sent either. */
export type TranscodeFormat = Exclude<StreamFormat, 'original'>

export interface StreamQuality {
  format: StreamFormat
  /** kbps. Ignored — and hidden in the UI — when format is 'original'. */
  bitrate: number
}

/**
 * Bitrates offered per format. The mp3 list mirrors connect's
 * ALLOWED_BITRATES (routes/local_stream.py), which rejects anything outside
 * it: a value that only exists on this side would produce a 400 rather than
 * audio.
 */
export const BITRATES: Record<TranscodeFormat, number[]> = {
  mp3: [320, 256, 192, 128, 96],
  aac: [256, 192, 128, 96],
  opus: [192, 128, 96, 64],
}

/**
 * Which formats each side can actually offer.
 *
 * Local playback is mp3 or nothing, and that is measured rather than
 * preferred: seeking in a transcode works by declaring a length of
 * `bitrate x duration`, and ffmpeg's aac and opus encoders don't hold the
 * bitrate they're given (aac 256 came out 12.75% under it), so the declared
 * length — and every seek made against it — would be wrong. The numbers are
 * in connect/routes/local_stream.py's ALLOWED_BITRATES comment.
 *
 * Casting has no such constraint: Beacon does the seeking itself, server
 * side, and never declares a length to anyone. opus is still left out
 * there, for the unrelated reason that Sonos won't play it at all (see
 * _COPY_MUXER_FOR_CODEC in core/streamer.py).
 */
export const LOCAL_FORMATS: StreamFormat[] = ['original', 'mp3']
export const CAST_FORMATS: StreamFormat[] = ['original', 'mp3', 'aac']

/**
 * What each format falls back to when the user switches to it from one
 * whose current bitrate it doesn't offer — 320 exists for mp3 and not for
 * aac, so switching mp3 320 -> aac has to land somewhere.
 */
const DEFAULT_BITRATE: Record<TranscodeFormat, number> = {
  mp3: 192,
  aac: 192,
  opus: 128,
}

/**
 * Untouched audio on both paths. Not a conservative placeholder: it is the
 * only setting that is never wrong for anyone, on any device, and every
 * install before this feature existed behaved exactly this way.
 */
const DEFAULTS = {
  local: { format: 'original' as StreamFormat, bitrate: 192 },
  cast: { format: 'original' as StreamFormat, bitrate: 192 },
}

/**
 * Account+device scoped, via accountScopedKey() below — a quality
 * preference is tied to *this* device's connection (the phone on mobile
 * data and the desktop on the LAN have no reason to agree, see this
 * module's own docstring), so it isn't the `beacon.playback` snapshot's
 * kind of per-account state that gets wiped outright on logout (see
 * clearPersistedPlayback()). But two different people sharing this same
 * device can still want different tradeoffs, so it's namespaced by account
 * too: switching back to an account you'd already configured this device
 * for still finds your own choice waiting, while a different account
 * logging in afterward gets its own independent (default) value instead of
 * silently inheriting yours.
 */
const STORAGE_KEY = 'beacon.quality'

export interface StreamQualitySettings {
  local: StreamQuality
  cast: StreamQuality
}

function sanitize(value: unknown, fallback: StreamQuality): StreamQuality {
  const raw = value as Partial<StreamQuality> | undefined
  const format = raw?.format
  if (format === 'original') return { format, bitrate: fallback.bitrate }
  if (format !== 'mp3' && format !== 'aac' && format !== 'opus') return { ...fallback }
  const bitrate = BITRATES[format].includes(raw?.bitrate as number)
    ? (raw!.bitrate as number)
    : DEFAULT_BITRATE[format]
  return { format, bitrate }
}

export function load(): StreamQualitySettings {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    const parsed = raw ? JSON.parse(raw) : {}
    return {
      local: sanitize(parsed?.local, DEFAULTS.local),
      cast: sanitize(parsed?.cast, DEFAULTS.cast),
    }
  } catch {
    // Unreadable or corrupt storage falls back to untouched audio, which is
    // the one answer that is never wrong — just possibly larger than the
    // listener wanted.
    return { local: { ...DEFAULTS.local }, cast: { ...DEFAULTS.cast } }
  }
}

export function save(settings: StreamQualitySettings): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(settings))
  } catch {
    // Storage full/unavailable — the setting still applies for this
    // session, it just won't survive a reload. Not worth a dialog.
  }
}

/** The bitrate to use when switching to `format`, keeping the current one
 * where that format offers it. */
export function bitrateFor(format: StreamFormat, current: number): number {
  if (format === 'original') return current
  return BITRATES[format].includes(current) ? current : DEFAULT_BITRATE[format]
}

/**
 * File suffixes every current browser decodes. A source outside this list
 * has to be converted whatever the bitrate says — otherwise the element
 * simply plays nothing, which is the other half of why local transcoding
 * exists at all.
 *
 * `m4a` is here because it is overwhelmingly AAC, but it can also hold
 * ALAC, which Chrome and Firefox refuse. That case isn't distinguishable
 * from the suffix — it is caught by the bitrate rule instead, since ALAC's
 * is far above any ceiling on offer.
 */
const BROWSER_PLAYABLE = new Set(['mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4'])

/**
 * Lossless suffixes. Always above a lossy ceiling, whatever number it
 * names — same rule as connect's own _LOSSLESS_CODECS
 * (core/streamer.py), stated in suffixes because that is what the media
 * server's metadata carries.
 */
const LOSSLESS = new Set(['flac', 'wav', 'alac', 'ape', 'wv', 'aiff', 'aif', 'dsf', 'dff'])

/** Why a track is being converted, as a stream-info reason key. */
export type LocalTranscodeReason = 'quality_limit' | 'browser_unsupported'

export interface LocalStreamPlan {
  /** What to actually request. `original` means the untouched file, even
   * where the setting names a format — see plan(). */
  quality: StreamQuality
  reason: LocalTranscodeReason | null
}

const PLAY_ORIGINAL: LocalStreamPlan = {
  quality: { format: 'original', bitrate: 0 },
  reason: null,
}

/**
 * What to fetch for `source` under the listener's `setting`.
 *
 * The setting is a **ceiling**, not an instruction: converting a 128 kbps
 * MP3 to "MP3 320" would re-encode it — losing quality — and produce a
 * *larger* file than the original, achieving the opposite of everything
 * the setting is for. A source that already fits is fetched untouched, and
 * the stream-info panel then correctly reports no conversion. Same rule
 * connect applies to casting (see _exceeds_quality_ceiling() in
 * core/streamer.py); this is the local half of it, decided here because
 * only the client knows which URL it is about to put in an `<audio>` tag.
 *
 * Judged on the media server's own metadata rather than a probe, since
 * this has to be answered synchronously while starting a track. That is
 * accurate enough for the question being asked — the exact numbers still
 * come from connect's probe for *display* (see
 * services/connect/localStreamInfo.ts).
 *
 * A source whose bitrate the server doesn't report is left alone. Guessing
 * "probably too big" would re-encode an already-small file for nothing —
 * the same rule connect follows for a number it doesn't have.
 */
export function plan(
  source: { format: string | null; bitRate: number | null },
  setting: StreamQuality,
): LocalStreamPlan {
  if (setting.format === 'original') return PLAY_ORIGINAL
  const suffix = source.format?.toLowerCase() ?? null

  if (suffix && !BROWSER_PLAYABLE.has(suffix)) {
    return { quality: { ...setting }, reason: 'browser_unsupported' }
  }
  if (suffix && LOSSLESS.has(suffix)) {
    return { quality: { ...setting }, reason: 'quality_limit' }
  }
  if (source.bitRate != null && source.bitRate > setting.bitrate) {
    return { quality: { ...setting }, reason: 'quality_limit' }
  }
  return PLAY_ORIGINAL
}
