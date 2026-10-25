/** The artist list's columns in its list form - see listColumns.ts. All but
 * the album count and the rating are counted out of the song catalogue
 * (artistStats.ts). */

import { fitListColumns, resolveListColumns, type ListColumn } from '@/services/library/listColumns'

export type ArtistColumnKey =
  | 'cover'
  | 'name'
  | 'genre'
  | 'years'
  | 'albumCount'
  | 'songCount'
  | 'duration'
  | 'playCount'
  | 'lastPlayed'
  | 'added'
  | 'rating'
  | 'actions'

export type ArtistColumn = ListColumn<ArtistColumnKey>

/** One of the figures at the end of a row: right-aligned, sorting by
 * itself. */
function figure(key: ArtistColumnKey, width: number, labelKey: string): ArtistColumn {
  return { key, width, labelKey, align: 'end', sortKeys: [key], optional: true }
}

export const ARTIST_COLUMNS: ArtistColumn[] = [
  { key: 'cover', width: 44, labelKey: null, align: 'start', sortKeys: [], optional: false },
  {
    key: 'name',
    width: null,
    labelKey: 'library.artist',
    align: 'start',
    sortKeys: ['name'],
    optional: false,
  },
  {
    key: 'genre',
    width: 120,
    labelKey: 'library.genre',
    align: 'start',
    sortKeys: ['genre'],
    optional: true,
  },
  figure('years', 96, 'library.artistYears'),
  figure('albumCount', 96, 'library.albums'),
  figure('songCount', 96, 'library.songs'),
  figure('duration', 104, 'library.duration'),
  figure('playCount', 96, 'library.plays'),
  figure('lastPlayed', 104, 'library.lastPlayed'),
  figure('added', 104, 'library.songFilter.added'),
  { ...figure('rating', 112, 'library.rating'), rated: true },
  // See albumColumns.ts's actions column.
  { key: 'actions', width: 72, labelKey: null, align: 'end', sortKeys: [], optional: false },
]

export const OPTIONAL_ARTIST_COLUMNS = ARTIST_COLUMNS.filter((column) => column.optional)

export const DEFAULT_ARTIST_COLUMNS: ArtistColumnKey[] = [
  'genre',
  'years',
  'albumCount',
  'songCount',
  'playCount',
  'rating',
]

/** The dates and the running time first, the counts last. */
const ARTIST_DROP_ORDER: ArtistColumnKey[] = [
  'added',
  'lastPlayed',
  'duration',
  'years',
  'genre',
  'playCount',
  'rating',
  'songCount',
  'albumCount',
]

export function artistColumnsFor(
  chosen: readonly ArtistColumnKey[],
  width: number,
  rated: boolean,
): ArtistColumn[] {
  return fitListColumns(resolveListColumns(ARTIST_COLUMNS, chosen, rated), width, ARTIST_DROP_ORDER)
}
