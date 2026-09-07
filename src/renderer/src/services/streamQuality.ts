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
 * The formats a *plan* can name, which is one more than a setting can:
 * 'flac' is never something anyone picks, it is what Original falls back
 * to for a source this browser cannot decode (see plan()). Keeping it out
 * of StreamFormat is what keeps it out of the settings dropdown, out of
 * the stored value, and out of the cast payload — none of which have any
 * business offering it.
 */
export type LocalPlanFormat = StreamFormat | 'flac'

export interface LocalStreamQuality {
  format: LocalPlanFormat
  /** kbps, and 0 where the format carries no such number — 'original' and
   * 'flac' both. */
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
 * Local playback was mp3-only for a long time, and the reason is worth
 * knowing because it no longer applies: seeking in a transcode used to
 * work by declaring a length of `bitrate x duration` and letting the
 * media element seek against it, which only lands correctly for a format
 * whose output really is that size. Only mp3 is — LAME's CBR pads every
 * frame — while an AAC encode follows the material and comes out smaller
 * wherever the music is cheap to encode. Beacon does that seeking itself
 * now (each position is a fresh request that starts there, see the
 * playback store's startLocalSong()), so nothing depends on the bitrate
 * being met and aac can be offered here too. The measurements are in
 * connect/routes/local_stream.py's ALLOWED_BITRATES comment.
 *
 * opus is here for the same reason and goes lower still — 96k of it is
 * what the other two need 192k for, which is the difference that matters
 * on a phone away from home. What it needs on this side is a browser that
 * decodes Ogg, which not every one does — see localFormats().
 *
 * Casting offers all three as well, and none of them is a promise about
 * the speaker: connect knows what each target can decode
 * (BaseDelivery.PLAYABLE_CODECS) and encodes the best format that target
 * actually plays, so Opus reaches a Chromecast as Opus, a Sonos as AAC and
 * an AirPlay device as MP3 rather than as silence (see _codec_for_ceiling()
 * in core/streamer.py). The bitrate is kept either way — it is a ceiling
 * somebody set for their connection, not a quality target to make up for.
 */
const ALL_LOCAL_FORMATS: StreamFormat[] = ['original', 'mp3', 'aac', 'opus']
export const CAST_FORMATS: StreamFormat[] = ['original', 'mp3', 'aac', 'opus']

/**
 * What a media element in *this* browser says it can decode, for the
 * formats above. Chrome and Firefox play all three; Safari has no Ogg
 * demuxer at all, so its answer for Opus is empty and offering it there
 * would be offering silence.
 *
 * Asked through a throwaway `<audio>` rather than assumed from the user
 * agent — the question is about a decoder, and the browser answers it
 * directly.
 */
const CAN_PLAY_TYPE: Record<TranscodeFormat, string> = {
  mp3: 'audio/mpeg',
  // ADTS, which is what connect's aac output is muxed into (see
  // _LOSSY_ENCODERS in core/streamer.py).
  aac: 'audio/aac',
  opus: 'audio/ogg; codecs="opus"',
}

/**
 * The local formats this browser can actually play.
 *
 * mp3 is the reference: every browser worth the name decodes it, so an
 * empty answer *for mp3* means the answer itself is worthless (jsdom says
 * nothing to anything) rather than that this browser plays no music. In
 * that case every format is offered, which is where this started before
 * the question was asked at all.
 */
export function localFormats(): StreamFormat[] {
  let probe: HTMLAudioElement
  try {
    probe = document.createElement('audio')
    if (!probe.canPlayType?.(CAN_PLAY_TYPE.mp3)) return [...ALL_LOCAL_FORMATS]
  } catch {
    return [...ALL_LOCAL_FORMATS]
  }
  return ALL_LOCAL_FORMATS.filter(
    (format) => format === 'original' || !!probe.canPlayType(CAN_PLAY_TYPE[format]),
  )
}

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

/** Where a format that isn't available lands, best first — the same order
 * connect uses for a cast device that can't decode what was asked for (see
 * _LOSSY_FALLBACK_ORDER in core/streamer.py). */
const FORMAT_FALLBACK_ORDER: TranscodeFormat[] = ['aac', 'mp3']

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

function sanitize(
  value: unknown,
  fallback: StreamQuality,
  available: StreamFormat[] = ALL_LOCAL_FORMATS,
): StreamQuality {
  const raw = value as Partial<StreamQuality> | undefined
  const format = raw?.format
  if (format === 'original') return { format, bitrate: fallback.bitrate }
  if (format !== 'mp3' && format !== 'aac' && format !== 'opus') return { ...fallback }
  const bitrate = BITRATES[format].includes(raw?.bitrate as number)
    ? (raw!.bitrate as number)
    : DEFAULT_BITRATE[format]
  // A setting saved on one browser can be read back on another — the same
  // account on a desktop and on an iPhone — and a format this one cannot
  // decode would play nothing at all. Falls back to the next format down
  // rather than to 'original', which would quietly undo the whole reason
  // the ceiling was set.
  if (!available.includes(format)) {
    const substitute = FORMAT_FALLBACK_ORDER.find((candidate) => available.includes(candidate))
    if (!substitute) return { format: 'original', bitrate: fallback.bitrate }
    return { format: substitute, bitrate: bitrateFor(substitute, bitrate) }
  }
  return { format, bitrate }
}

export function load(): StreamQualitySettings {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    const parsed = raw ? JSON.parse(raw) : {}
    return {
      // Only the local half is judged against this browser: the cast half
      // describes what a speaker gets, and connect narrows that to the
      // target's own codecs (see CAST_FORMATS above).
      local: sanitize(parsed?.local, DEFAULTS.local, localFormats()),
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
 * The media type to ask a browser about, per source file suffix. A source
 * this browser can't decode has to be converted whatever the bitrate says
 * — otherwise the element simply plays nothing, which is the other half of
 * why local transcoding exists at all.
 *
 * Asked rather than assumed, because the answer differs: Chrome and
 * Firefox play all of these, while Safari has no Ogg demuxer and so plays
 * neither the `ogg`/`oga` nor the `opus` line. A list hard-coded to
 * "every current browser" was really a list for Chrome, and on an iPhone
 * it meant a Vorbis track was fetched untouched and played nothing.
 *
 * `m4a` is here because it is overwhelmingly AAC, but it can also hold
 * ALAC, which Chrome and Firefox refuse. That case isn't distinguishable
 * from the suffix — it is caught by the bitrate rule instead, since ALAC's
 * is far above any ceiling on offer.
 */
const SOURCE_MEDIA_TYPE: Record<string, string | undefined> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs="opus"',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
}

/** Whether this browser plays a source with that suffix.
 *
 * A suffix nothing here knows about is "no" — it is exactly the ALAC/APE/
 * WavPack case local transcoding was added for. An unusable answer (jsdom,
 * or anything else that says nothing to `audio/mpeg` either) falls back to
 * the fixed list this used to be, so nothing starts converting everything
 * because the question could not be asked. */
function browserPlays(suffix: string): boolean {
  const type = SOURCE_MEDIA_TYPE[suffix]
  if (!type) return false
  try {
    const probe = document.createElement('audio')
    if (!probe.canPlayType?.(CAN_PLAY_TYPE.mp3)) return true
    return !!probe.canPlayType(type)
  } catch {
    return true
  }
}

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
  quality: LocalStreamQuality
  reason: LocalTranscodeReason | null
}

const PLAY_ORIGINAL: LocalStreamPlan = {
  quality: { format: 'original', bitrate: 0 },
  reason: null,
}

/**
 * What Original asks for when the source cannot be decoded here — the one
 * case where "untouched" and "audible" cannot both be had.
 *
 * FLAC wherever this browser takes it, which is everywhere that matters
 * (Chrome, Firefox, and Safari since 11): the audio is re-wrapped, not
 * re-encoded, so nothing is lost and the listener's choice is still
 * honoured. Only where even that is refused does this fall to a lossy
 * format, and then it is a choice between something audible and nothing at
 * all rather than a quality trade anybody asked for.
 */
function losslessRescue(): LocalStreamQuality {
  if (browserPlays('flac')) return { format: 'flac', bitrate: 0 }
  const available = localFormats()
  const substitute = FORMAT_FALLBACK_ORDER.find((candidate) => available.includes(candidate))
  return substitute
    ? { format: substitute, bitrate: DEFAULT_BITRATE[substitute] }
    : { format: 'mp3', bitrate: DEFAULT_BITRATE.mp3 }
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
  const suffix = source.format?.toLowerCase() ?? null
  const undecodable = suffix != null && !browserPlays(suffix)

  // Asked before the Original shortcut below rather than after it, which
  // is the one thing that changed here: Original used to return untouched
  // audio for a source the browser has no decoder for, and untouched audio
  // that plays nothing is not the choice anybody was making. An ALAC
  // library — or an Ogg one on an iPhone — was silent on the *default*
  // setting while every other setting rescued it.
  //
  // What it is rescued *to* is the whole reason this can be done without
  // making the setting mean something else: losslessRescue() changes the
  // container and nothing else, so "Original" is still true of every bit
  // that comes out. See LOSSLESS_FORMAT in connect/routes/local_stream.py.
  if (setting.format === 'original') {
    if (!undecodable) return PLAY_ORIGINAL
    return { quality: losslessRescue(), reason: 'browser_unsupported' }
  }

  if (undecodable) {
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
