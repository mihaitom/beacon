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
}

export interface SongDetailSection {
  titleKey: string
  rows: SongDetailRow[]
}

function names(entries?: { name: string }[]): string | null {
  if (!entries?.length) return null
  const joined = entries
    .map((entry) => entry.name)
    .filter(Boolean)
    .join(', ')
  return joined || null
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

function section(titleKey: string, rows: [string, string | number | null][]): SongDetailSection {
  return {
    titleKey,
    rows: rows
      .filter(([, value]) => value != null && value !== '')
      .map(([labelKey, value]) => ({ labelKey, value: String(value) })),
  }
}

export function songDetailSections(
  detail: RawSongDetail,
  locale: string = 'en',
): SongDetailSection[] {
  const artist = detail.displayArtist ?? names(detail.artists) ?? detail.artist ?? null
  const albumArtist = detail.displayAlbumArtist ?? names(detail.albumArtists) ?? null
  const genre = names(detail.genres) ?? detail.genre ?? null
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
      ['songInfo.genre', genre],
      ['songInfo.bpm', detail.bpm ?? null],
      ['songInfo.mood', detail.moods?.join(', ') || null],
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
      ['songInfo.isrc', detail.isrc?.join(', ') || null],
    ]),
  ].filter((entry) => entry.rows.length > 0)
}
