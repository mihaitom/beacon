import type { RawSongDetail } from '@/services/subsonic/types'

/**
 * Turns one track's record from the media server into the rows the info
 * dialog shows.
 *
 * A pure function rather than logic in the dialog, because the interesting
 * part is entirely about the data: which of these fields a server actually
 * fills in varies a lot (Navidrome answers with the full OpenSubsonic set,
 * the Jellyfin and Plex bridges with what those two expose), and a field
 * nobody sent must leave no trace - an empty row reads as "this track has
 * no bitrate" rather than "your server does not report one".
 *
 * Nothing is invented here either: every value below comes from the
 * server's own answer. The only work done to it is formatting - bytes into
 * MB, a timestamp into the reader's own date format.
 */
export interface SongDetailRow {
  labelKey: string
  value: string
  /** Set on the rows that are a *list* of tags rather than one value -
   * genres and moods, which routinely hold three or four. The dialog shows
   * these as chips; `value` stays filled with the joined form, so anything
   * that just wants the text (a test, a future export) needs no special
   * case for them. */
  values?: string[]
}

export interface SongDetailSection {
  titleKey: string
  rows: SongDetailRow[]
}

function names(entries?: { name: string }[]): string[] {
  return entries?.map((entry) => entry.name).filter(Boolean) ?? []
}

function formatDuration(seconds?: number): string | null {
  if (seconds == null) return null
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** Binary MB, the unit a file manager shows for the same file. Two
 * decimals below 10 MB so a short track is not just "4 MB". */
function formatSize(bytes?: number): string | null {
  if (bytes == null) return null
  const mb = bytes / 1024 / 1024
  if (mb < 10) return `${mb.toFixed(2)} MB`
  return `${Math.round(mb)} MB`
}

function formatSampleRate(hz?: number): string | null {
  if (!hz) return null
  // 44100 reads as 44.1 kHz, 48000 as 48 kHz - trailing zeroes dropped
  // rather than always printing one decimal.
  return `${String(Number((hz / 1000).toFixed(1)))} kHz`
}

/** Timestamps come through as ISO strings. Shown in the reader's own
 * locale, and left out entirely when the server sent something unparseable
 * rather than printing "Invalid Date". */
function formatDate(value: string | undefined, locale: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(locale)
}

function formatGain(db?: number): string | null {
  if (db == null) return null
  return `${db > 0 ? '+' : ''}${db.toFixed(2)} dB`
}

function join(entries: string[]): string | null {
  return entries.join(', ') || null
}

/** A row's value: one scalar, or a list of tags that becomes chips. Either
 * way an empty one drops out of the section entirely. */
type RowValue = string | number | null | string[]

function section(titleKey: string, rows: [string, RowValue][]): SongDetailSection {
  return {
    titleKey,
    rows: rows
      .filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : value != null && value !== '',
      )
      .map(([labelKey, value]) =>
        Array.isArray(value)
          ? { labelKey, value: value.join(', '), values: value }
          : { labelKey, value: String(value) },
      ),
  }
}

export function songDetailSections(
  detail: RawSongDetail,
  locale: string = 'en',
): SongDetailSection[] {
  const artist = detail.displayArtist ?? join(names(detail.artists)) ?? detail.artist ?? null
  const albumArtist = detail.displayAlbumArtist ?? join(names(detail.albumArtists)) ?? null
  // As a list, not a joined string: several genres per track is the norm,
  // and the dialog gives each one its own chip. A server that only has the
  // single legacy field contributes exactly one.
  const genres = names(detail.genres)
  if (!genres.length && detail.genre) genres.push(detail.genre)
  const gain = detail.replayGain ?? {}

  return [
    section('songInfo.sectionTrack', [
      ['songInfo.title', detail.title ?? null],
      // Only when it differs: a sort name equal to the title is what every
      // tagger writes by default and says nothing.
      [
        'songInfo.sortName',
        detail.sortName && detail.sortName !== detail.title ? detail.sortName : null,
      ],
      ['songInfo.artist', artist],
      ['songInfo.albumArtist', albumArtist && albumArtist !== artist ? albumArtist : null],
      ['songInfo.album', detail.album ?? null],
      ['songInfo.track', detail.track ?? null],
      ['songInfo.disc', detail.discNumber ?? null],
      ['songInfo.year', detail.year ?? null],
      ['songInfo.genre', genres],
      ['songInfo.bpm', detail.bpm ?? null],
      ['songInfo.mood', detail.moods ?? []],
      ['songInfo.comment', detail.comment ?? null],
      ['songInfo.explicit', detail.explicitStatus ?? null],
    ]),
    section('songInfo.sectionAudio', [
      ['songInfo.duration', formatDuration(detail.duration)],
      ['songInfo.format', detail.suffix ? detail.suffix.toUpperCase() : null],
      ['songInfo.contentType', detail.contentType ?? null],
      ['songInfo.bitrate', detail.bitRate ? `${detail.bitRate} kbps` : null],
      ['songInfo.sampleRate', formatSampleRate(detail.samplingRate)],
      ['songInfo.bitDepth', detail.bitDepth ? `${detail.bitDepth} bit` : null],
      ['songInfo.channels', detail.channelCount ?? null],
      ['songInfo.size', formatSize(detail.size)],
      // Whatever the server calls the file's location, unchanged. Worth
      // knowing before reading it as a real path: Navidrome synthesises
      // this one for Subsonic clients ("Artist/Album/01-03 - Title.mp3",
      // no music folder in front) unless that client's player has
      // "Report Real Path" switched on in its own settings.
      ['songInfo.path', detail.path ?? null],
    ]),
    section('songInfo.sectionLibrary', [
      ['songInfo.playCount', detail.playCount ?? null],
      ['songInfo.lastPlayed', formatDate(detail.played, locale)],
      ['songInfo.added', formatDate(detail.created, locale)],
      // 0 means unrated, same as everywhere else in the app - not a rating
      // of zero stars.
      ['songInfo.rating', detail.userRating ? `${detail.userRating}/5` : null],
      ['songInfo.replayGainTrack', formatGain(gain.trackGain)],
      ['songInfo.replayGainAlbum', formatGain(gain.albumGain)],
    ]),
    section('songInfo.sectionIds', [
      ['songInfo.musicBrainzId', detail.musicBrainzId ?? null],
      // Joined rather than chipped, unlike the two above: an ISRC is an
      // identifier to copy out, not a tag to read.
      ['songInfo.isrc', detail.isrc?.join(', ') || null],
    ]),
  ].filter((entry) => entry.rows.length > 0)
}
