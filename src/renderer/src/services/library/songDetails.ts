import type { RawSongDetail } from '@/services/subsonic/types'
import { formatDuration, formatSampleRate, formatSize, formatTimestamp } from './songFormat'

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
      ['songInfo.lastPlayed', formatTimestamp(detail.played, locale)],
      ['songInfo.added', formatTimestamp(detail.created, locale)],
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
