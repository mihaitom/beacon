/**
 * Every column a song table can have, in the order they appear - the one
 * place that knows how wide a column is, how it aligns, what it says and
 * what it sorts by.
 *
 * It exists because that knowledge used to be spread across two files:
 * SongTableHeader.vue drew the labels, SongRow.vue drew the cells, and each
 * carried its own copy of the widths with a comment in both warning that
 * they had to be kept identical by hand. Both now render this array, so a
 * column is one entry here and cannot drift out of alignment with itself.
 *
 * `optional: false` marks the four a song table is not a song table
 * without - the number, the title, the running time and the rating/star/menu
 * cluster. The rest is the user's own choice (see stores/songColumns.ts),
 * which is also why the data behind them is mapped onto every Song
 * (services/subsonic/mappers.ts) rather than fetched per row: on an
 * OpenSubsonic server a list entry already carries all of it.
 */

import type { Song } from '@/types/library'
import { formatDate, formatDuration, formatSampleRate, formatSize } from './songFormat'

export type SongColumnKey =
  | 'index'
  | 'cover'
  | 'title'
  | 'album'
  | 'genre'
  | 'year'
  | 'track'
  | 'disc'
  | 'bpm'
  | 'sampleRate'
  | 'size'
  | 'path'
  | 'comment'
  | 'added'
  | 'lastPlayed'
  | 'playCount'
  | 'format'
  | 'duration'
  | 'actions'

/** How a cell draws itself. Everything that is just words is 'text' and
 * comes out of the column's own `text()`; the four named ones are the cells
 * that hold something else - artwork, two lines with a link in them, a link,
 * and the rating/star/menu cluster. */
export type SongColumnCell = 'index' | 'cover' | 'title' | 'album' | 'actions' | 'text'

export interface SongColumn {
  key: SongColumnKey
  /** An existing i18n key wherever the app already names this field -
   * `library.*` for the columns that had a heading before this file, and
   * the track-info dialog's `songInfo.*` for the ones it already labels.
   * Deliberately not a fresh set of `library.column*` keys: that would be
   * the same twenty words translated a second time in five locales, free to
   * drift away from the dialog's wording. */
  labelKey: string
  cell: SongColumnCell
  /** The CSS `flex` shorthand for this column, in both the header and the
   * row - see this file's own docstring for why it lives here. */
  flex: string
  align: 'start' | 'end'
  /** Offered in the column menu. False for the four structural ones. */
  optional: boolean
  /** Width of the placeholder bar in a loading row, so the skeleton keeps
   * the shape of the table it is standing in for. */
  skeletonWidth: string
  /** Null for a column with nothing orderable behind it (the cover). */
  sortValue: ((song: Song) => string | number) | null
  /** Null for the cells that are not text (see `cell`). */
  text: ((song: Song, locale: string) => string) | null
}

/** What an empty cell shows - a column the server has no data for reads as
 * a blank, not as a zero or a gap. */
const EMPTY = '—'

function text(value: string | number | null | undefined): string {
  return value == null || value === '' ? EMPTY : String(value)
}

function lower(value: string | null | undefined): string {
  return (value ?? '').toLowerCase()
}

/** Unset dates sort to the end of an ascending list rather than to the
 * front, where a never-played track would otherwise crowd out the ones the
 * sort is actually about. */
function timeValue(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
}

export const SONG_COLUMNS: SongColumn[] = [
  {
    key: 'index',
    labelKey: '',
    cell: 'index',
    flex: '0 0 44px',
    align: 'end',
    optional: false,
    skeletonWidth: '0',
    sortValue: null,
    text: null,
  },
  {
    key: 'cover',
    labelKey: 'library.cover',
    cell: 'cover',
    flex: '0 0 40px',
    align: 'start',
    optional: true,
    skeletonWidth: '40',
    sortValue: null,
    text: null,
  },
  {
    key: 'title',
    labelKey: 'library.title',
    cell: 'title',
    flex: '3 1 160px',
    align: 'start',
    optional: false,
    skeletonWidth: '60%',
    sortValue: (song) => lower(song.title),
    text: null,
  },
  {
    key: 'album',
    labelKey: 'library.album',
    cell: 'album',
    flex: '2 1 120px',
    align: 'start',
    optional: true,
    skeletonWidth: '70%',
    sortValue: (song) => lower(song.album),
    text: null,
  },
  {
    key: 'genre',
    labelKey: 'library.genre',
    cell: 'text',
    flex: '1.5 1 90px',
    align: 'start',
    optional: true,
    skeletonWidth: '60%',
    sortValue: (song) => lower(song.genre),
    text: (song) => text(song.genre),
  },
  {
    key: 'year',
    labelKey: 'library.year',
    cell: 'text',
    flex: '0 0 44px',
    align: 'end',
    optional: true,
    skeletonWidth: '28',
    sortValue: (song) => song.year ?? 0,
    text: (song) => text(song.year),
  },
  {
    key: 'track',
    labelKey: 'songInfo.track',
    cell: 'text',
    flex: '0 0 44px',
    align: 'end',
    optional: true,
    skeletonWidth: '24',
    sortValue: (song) => song.trackNumber ?? 0,
    text: (song) => text(song.trackNumber),
  },
  {
    key: 'disc',
    labelKey: 'songInfo.disc',
    cell: 'text',
    flex: '0 0 44px',
    align: 'end',
    optional: true,
    skeletonWidth: '20',
    sortValue: (song) => song.discNumber ?? 0,
    text: (song) => text(song.discNumber),
  },
  {
    key: 'bpm',
    labelKey: 'songInfo.bpm',
    cell: 'text',
    flex: '0 0 52px',
    align: 'end',
    optional: true,
    skeletonWidth: '24',
    sortValue: (song) => song.bpm ?? 0,
    text: (song) => text(song.bpm),
  },
  {
    // Both figures in one column, the way the format column already reads
    // "MP3 · 320 kbps": bit depth on its own is three characters of column
    // for a number that only means anything next to the rate.
    key: 'sampleRate',
    labelKey: 'songInfo.sampleRate',
    cell: 'text',
    flex: '0 0 110px',
    align: 'end',
    optional: true,
    skeletonWidth: '70',
    sortValue: (song) => song.sampleRate ?? 0,
    text: (song) => {
      const rate = formatSampleRate(song.sampleRate)
      const depth = song.bitDepth ? `${song.bitDepth} bit` : null
      if (rate && depth) return `${rate} · ${depth}`
      return text(rate ?? depth)
    },
  },
  {
    key: 'size',
    labelKey: 'songInfo.size',
    cell: 'text',
    flex: '0 0 76px',
    align: 'end',
    optional: true,
    skeletonWidth: '52',
    sortValue: (song) => song.size ?? 0,
    text: (song) => text(formatSize(song.size)),
  },
  {
    key: 'path',
    labelKey: 'songInfo.path',
    cell: 'text',
    flex: '2 1 120px',
    align: 'start',
    optional: true,
    skeletonWidth: '80%',
    sortValue: (song) => lower(song.path),
    text: (song) => text(song.path),
  },
  {
    key: 'comment',
    labelKey: 'songInfo.comment',
    cell: 'text',
    flex: '1.5 1 90px',
    align: 'start',
    optional: true,
    skeletonWidth: '65%',
    sortValue: (song) => lower(song.comment),
    text: (song) => text(song.comment),
  },
  {
    key: 'added',
    labelKey: 'songInfo.added',
    cell: 'text',
    flex: '0 0 92px',
    align: 'end',
    optional: true,
    skeletonWidth: '64',
    sortValue: (song) => timeValue(song.added),
    text: (song, locale) => text(formatDate(song.added, locale)),
  },
  {
    key: 'lastPlayed',
    labelKey: 'songInfo.lastPlayed',
    cell: 'text',
    flex: '0 0 92px',
    align: 'end',
    optional: true,
    skeletonWidth: '64',
    sortValue: (song) => timeValue(song.lastPlayed),
    text: (song, locale) => text(formatDate(song.lastPlayed, locale)),
  },
  {
    key: 'playCount',
    labelKey: 'library.plays',
    cell: 'text',
    flex: '0 0 44px',
    align: 'end',
    optional: true,
    skeletonWidth: '20',
    sortValue: (song) => song.playCount ?? 0,
    // A play count of zero is a real answer, unlike an absent field.
    text: (song) => String(song.playCount ?? 0),
  },
  {
    key: 'format',
    labelKey: 'library.format',
    cell: 'text',
    flex: '0 0 120px',
    align: 'end',
    optional: true,
    skeletonWidth: '60',
    // Format has no natural order of its own - bitrate is the meaningful
    // "quality" ranking underneath that column.
    sortValue: (song) => song.bitRate ?? 0,
    text: (song) => {
      const format = song.format ? song.format.toUpperCase() : null
      const bitRate = song.bitRate ? `${song.bitRate} kbps` : null
      if (format && bitRate) return `${format} · ${bitRate}`
      return text(format ?? bitRate)
    },
  },
  {
    key: 'duration',
    labelKey: 'library.duration',
    cell: 'text',
    flex: '0 0 44px',
    align: 'end',
    optional: false,
    skeletonWidth: '30',
    sortValue: (song) => song.duration ?? 0,
    text: (song) => text(formatDuration(song.duration)),
  },
  {
    // The rating stars, the favorite heart and the "..." menu. Only the
    // stars have a heading, which is why its label is padded off the right
    // edge by the other two's width - see SongTableHeader.vue.
    key: 'actions',
    labelKey: 'library.rating',
    cell: 'actions',
    flex: '0 0 200px',
    align: 'end',
    optional: false,
    skeletonWidth: '0',
    sortValue: (song) => song.rating ?? 0,
    text: null,
  },
]

const BY_KEY = new Map(SONG_COLUMNS.map((column) => [column.key, column]))

export function songColumn(key: SongColumnKey): SongColumn | undefined {
  return BY_KEY.get(key)
}

/** The columns the user can switch on and off, in the order the menu lists
 * them - which is the order they appear in the table, so the menu reads as
 * a picture of it. */
export const OPTIONAL_SONG_COLUMNS = SONG_COLUMNS.filter((column) => column.optional)

/** What a fresh install shows: exactly the set the views used to hard-code
 * between them, so nobody's table changes shape on upgrade. */
export const DEFAULT_SONG_COLUMNS: SongColumnKey[] = [
  'cover',
  'album',
  'genre',
  'year',
  'playCount',
  'format',
]

/**
 * The columns one table actually renders: the structural ones, plus the
 * chosen optional ones, minus whatever this particular list has no use for
 * - always in SONG_COLUMNS order, never in the order they were picked.
 *
 * `exclude` is the view's own veto, not a preference: an album's tracklist
 * has nothing to say with an "Album" column of one repeated value, and a
 * genre page's rows are all the same genre. A column vetoed here stays in
 * the user's selection; it simply isn't drawn on this page.
 */
export function resolveSongColumns(
  selected: readonly SongColumnKey[],
  exclude: readonly SongColumnKey[] = [],
): SongColumn[] {
  const chosen = new Set(selected)
  const vetoed = new Set(exclude)
  return SONG_COLUMNS.filter(
    (column) => !vetoed.has(column.key) && (!column.optional || chosen.has(column.key)),
  )
}
