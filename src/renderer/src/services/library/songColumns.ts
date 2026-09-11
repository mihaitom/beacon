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
 *
 * Between those four, the order is by subject rather than by the order the
 * columns were built: the track itself (album, disc, track, genre, year,
 * BPM, comment), then what this library knows about listening to it (added,
 * last played, plays), then the file behind it (format, sample rate, size,
 * path). Two columns that answer the same kind of question should be read
 * without looking past the ones that don't - the file's own figures used to
 * sit three columns apart with the play count between them. The picker
 * lists the optional ones in this same order (OPTIONAL_SONG_COLUMNS), so it
 * reads as a picture of the table.
 */

import type { Song } from '@/types/library'
import type { ServerType } from '@/services/capabilities'
import { formatDate, formatDuration, formatSampleRate, formatSize } from './songFormat'

export type SongColumnKey =
  | 'index'
  | 'cover'
  | 'title'
  | 'album'
  | 'disc'
  | 'track'
  | 'genre'
  | 'year'
  | 'bpm'
  | 'comment'
  | 'added'
  | 'lastPlayed'
  | 'playCount'
  | 'format'
  | 'sampleRate'
  | 'size'
  | 'path'
  | 'duration'
  | 'rating'
  | 'actions'

/** How a cell draws itself. Everything that is just words is 'text' and
 * comes out of the column's own `text()`; the named ones are the cells that
 * hold something else - artwork, two lines with a link in them, a link, the
 * rating stars, and the favorite/menu cluster. */
export type SongColumnCell = 'index' | 'cover' | 'title' | 'album' | 'rating' | 'actions' | 'text'

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
  /** The width this column may never fall below, however many other columns
   * are switched on. Without it, flex-shrink takes the text columns to
   * nothing long before the fixed ones give up a pixel: with every column
   * on, the title column measured 1px wide and every heading sat over its
   * neighbour. A table too wide for the window now scrolls sideways
   * instead, which is a thing the reader can see and undo. */
  minWidth: string
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
  /** The servers whose *list* responses carry this field, or null for the
   * ones every server answers. A column is only as good as the data behind
   * it: Jellyfin's song lists deliberately leave out the file's own figures
   * (see jellyfin_bridge.py's _SONG_LIST_FIELDS - asking for them costs real
   * time per item), and Plex sends the size but not the path or the audio
   * stream. Rather than a column of dashes on every row, those are left out
   * of the table and shown in the menu as something this server does not
   * report. */
  servers: ServerType[] | null
}

/** Everything an OpenSubsonic server answers with, and nothing else does. */
const SUBSONIC_ONLY: ServerType[] = ['subsonic']

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
    minWidth: '44px',
    align: 'end',
    optional: false,
    skeletonWidth: '0',
    sortValue: null,
    text: null,
    servers: null,
  },
  {
    key: 'cover',
    labelKey: 'library.cover',
    cell: 'cover',
    flex: '0 0 40px',
    minWidth: '40px',
    align: 'start',
    optional: true,
    skeletonWidth: '40',
    sortValue: null,
    text: null,
    servers: null,
  },
  {
    key: 'title',
    labelKey: 'library.title',
    cell: 'title',
    flex: '3 1 200px',
    minWidth: '160px',
    align: 'start',
    optional: false,
    skeletonWidth: '60%',
    sortValue: (song) => lower(song.title),
    text: null,
    servers: null,
  },
  // The track itself: where it sits in a release, and what the tags say
  // about it.
  {
    key: 'album',
    labelKey: 'library.album',
    cell: 'album',
    flex: '2 1 160px',
    minWidth: '120px',
    align: 'start',
    optional: true,
    skeletonWidth: '70%',
    sortValue: (song) => lower(song.album),
    text: null,
    servers: null,
  },
  {
    key: 'disc',
    labelKey: 'songInfo.disc',
    cell: 'text',
    flex: '0 0 76px',
    minWidth: '76px',
    align: 'end',
    optional: true,
    skeletonWidth: '20',
    sortValue: (song) => song.discNumber ?? 0,
    text: (song) => text(song.discNumber),
    servers: null,
  },
  {
    key: 'track',
    labelKey: 'songInfo.track',
    cell: 'text',
    flex: '0 0 84px',
    minWidth: '84px',
    align: 'end',
    optional: true,
    skeletonWidth: '24',
    sortValue: (song) => song.trackNumber ?? 0,
    text: (song) => text(song.trackNumber),
    servers: null,
  },
  {
    key: 'genre',
    labelKey: 'library.genre',
    cell: 'text',
    flex: '1.2 1 120px',
    minWidth: '90px',
    align: 'start',
    optional: true,
    skeletonWidth: '60%',
    sortValue: (song) => lower(song.genre),
    text: (song) => text(song.genre),
    servers: null,
  },
  {
    key: 'year',
    labelKey: 'library.year',
    cell: 'text',
    flex: '0 0 72px',
    minWidth: '72px',
    align: 'end',
    optional: true,
    skeletonWidth: '28',
    sortValue: (song) => song.year ?? 0,
    text: (song) => text(song.year),
    servers: null,
  },
  {
    key: 'bpm',
    labelKey: 'songInfo.bpm',
    cell: 'text',
    flex: '0 0 56px',
    minWidth: '56px',
    align: 'end',
    optional: true,
    skeletonWidth: '24',
    sortValue: (song) => song.bpm ?? 0,
    text: (song) => text(song.bpm),
    servers: SUBSONIC_ONLY,
  },
  {
    key: 'comment',
    labelKey: 'songInfo.comment',
    cell: 'text',
    flex: '1.5 1 150px',
    minWidth: '126px',
    align: 'start',
    optional: true,
    skeletonWidth: '65%',
    sortValue: (song) => lower(song.comment),
    text: (song) => text(song.comment),
    servers: SUBSONIC_ONLY,
  },

  // This library's own history with it.
  {
    key: 'added',
    labelKey: 'songInfo.added',
    cell: 'text',
    flex: '0 0 116px',
    minWidth: '116px',
    align: 'end',
    optional: true,
    skeletonWidth: '64',
    sortValue: (song) => timeValue(song.added),
    text: (song, locale) => text(formatDate(song.added, locale)),
    servers: null,
  },
  {
    key: 'lastPlayed',
    labelKey: 'library.lastPlayed',
    cell: 'text',
    flex: '0 0 116px',
    minWidth: '116px',
    align: 'end',
    optional: true,
    skeletonWidth: '64',
    sortValue: (song) => timeValue(song.lastPlayed),
    text: (song, locale) => text(formatDate(song.lastPlayed, locale)),
    servers: null,
  },
  {
    key: 'playCount',
    labelKey: 'library.plays',
    cell: 'text',
    flex: '0 0 96px',
    minWidth: '96px',
    align: 'end',
    optional: true,
    skeletonWidth: '20',
    sortValue: (song) => song.playCount ?? 0,
    // A play count of zero is a real answer, unlike an absent field.
    text: (song) => String(song.playCount ?? 0),
    servers: null,
  },

  // The file behind it. Sample rate and size are the two most often read
  // next to the format, which is why they follow it directly.
  {
    key: 'format',
    labelKey: 'library.format',
    cell: 'text',
    flex: '0 0 120px',
    minWidth: '120px',
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
    servers: null,
  },
  {
    // Both figures in one column, the way the format column already reads
    // "MP3 · 320 kbps": bit depth on its own is three characters of column
    // for a number that only means anything next to the rate.
    key: 'sampleRate',
    labelKey: 'library.sampleRate',
    cell: 'text',
    flex: '0 0 120px',
    minWidth: '120px',
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
    servers: SUBSONIC_ONLY,
  },
  {
    key: 'size',
    labelKey: 'library.size',
    cell: 'text',
    flex: '0 0 106px',
    minWidth: '106px',
    align: 'end',
    optional: true,
    skeletonWidth: '52',
    sortValue: (song) => song.size ?? 0,
    text: (song) => text(formatSize(song.size)),
    servers: ['subsonic', 'plex'],
  },
  {
    key: 'path',
    labelKey: 'songInfo.path',
    cell: 'text',
    flex: '2 1 160px',
    minWidth: '120px',
    align: 'start',
    optional: true,
    skeletonWidth: '80%',
    sortValue: (song) => lower(song.path),
    text: (song) => text(song.path),
    servers: SUBSONIC_ONLY,
  },

  // Closing the row, as the number and the title open it - the running
  // time, then this listener's own marks on the track.
  {
    key: 'duration',
    labelKey: 'library.duration',
    cell: 'text',
    flex: '0 0 96px',
    minWidth: '96px',
    align: 'end',
    optional: false,
    skeletonWidth: '30',
    sortValue: (song) => song.duration ?? 0,
    text: (song) => text(formatDuration(song.duration)),
    servers: null,
  },
  {
    // Switchable like any other column, and kept next to the heart rather
    // than filed with the play count: the two are one gesture - what this
    // listener thinks of the track - and both are controls, not readings.
    // The stars themselves only appear on a rated row or a hovered one (see
    // SongRow.vue), so an unrated library shows a quiet column, not an
    // empty one.
    key: 'rating',
    labelKey: 'library.rating',
    cell: 'rating',
    flex: '0 0 112px',
    minWidth: '112px',
    align: 'end',
    optional: true,
    skeletonWidth: '0',
    sortValue: (song) => song.rating ?? 0,
    text: null,
    // Jellyfin has only a boolean favorite, no 1-5 scale (see
    // services/capabilities.ts) - there the column isn't offered at all.
    servers: ['subsonic', 'plex'],
  },
  {
    // The favorite heart and the "..." menu. No heading of its own: neither
    // is a field, and there is nothing here to sort by.
    key: 'actions',
    labelKey: '',
    cell: 'actions',
    flex: '0 0 80px',
    minWidth: '80px',
    align: 'end',
    optional: false,
    skeletonWidth: '0',
    sortValue: null,
    text: null,
    servers: null,
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
  'rating',
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
  serverType: ServerType | null = null,
  capabilities: SongActionCapabilities = { favorites: true },
): SongColumn[] {
  const chosen = new Set(selected)
  const vetoed = new Set(exclude)
  return SONG_COLUMNS.filter(
    (column) =>
      !vetoed.has(column.key) &&
      songColumnAvailable(column, serverType) &&
      (!column.optional || chosen.has(column.key)),
  ).map((column) => (column.cell === 'actions' ? actionsColumnFor(column, capabilities) : column))
}

/** What the row's trailing cell can hold on this server - see
 * services/capabilities.ts, which is where this comes from. */
export interface SongActionCapabilities {
  favorites: boolean
}

// Measured in a real browser (see the layout test): each icon button comes
// to 28px, the sums below with a little room for a focus ring.
const ACTIONS_WIDTH = { withFavorites: 80, menuOnly: 52 }

/**
 * The trailing cell, sized for what this server actually puts in it: Plex's
 * core API has no favorite of its own (see media/plex_bridge.py), so there
 * the cell holds the menu button alone and the heart's 28px would be width
 * the title and album columns are squeezed out of.
 */
function actionsColumnFor(column: SongColumn, capabilities: SongActionCapabilities): SongColumn {
  const width = capabilities.favorites ? ACTIONS_WIDTH.withFavorites : ACTIONS_WIDTH.menuOnly
  return { ...column, flex: `0 0 ${width}px`, minWidth: `${width}px` }
}

/** Whether this server's song lists carry what the column shows. A column
 * it cannot fill is left out of the table entirely rather than drawn as a
 * row of dashes - and stays in the selection, so it comes back on a server
 * that does report it. */
export function songColumnAvailable(column: SongColumn, serverType: ServerType | null): boolean {
  return !serverType || !column.servers || column.servers.includes(serverType)
}
