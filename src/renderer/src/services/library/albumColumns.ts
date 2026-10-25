/** The album list's columns in its list form - see listColumns.ts. */

import { fitListColumns, resolveListColumns, type ListColumn } from '@/services/library/listColumns'

export type AlbumColumnKey =
  | 'cover'
  | 'name'
  | 'genre'
  | 'releaseType'
  | 'year'
  | 'songCount'
  | 'duration'
  | 'added'
  | 'rating'
  | 'star'

export type AlbumColumn = ListColumn<AlbumColumnKey>

export const ALBUM_COLUMNS: AlbumColumn[] = [
  { key: 'cover', width: 44, labelKey: null, align: 'start', sortKeys: [], optional: false },
  {
    key: 'name',
    width: null,
    labelKey: null,
    align: 'start',
    sortKeys: ['name', 'artist'],
    optional: false,
  },
  {
    key: 'genre',
    width: 120,
    labelKey: 'library.genre',
    align: 'start',
    sortKeys: [],
    optional: true,
  },
  {
    key: 'releaseType',
    width: 96,
    labelKey: 'library.albumColumnType',
    align: 'start',
    sortKeys: [],
    optional: true,
  },
  {
    key: 'year',
    width: 56,
    labelKey: 'library.year',
    align: 'end',
    sortKeys: ['year'],
    optional: true,
  },
  {
    key: 'songCount',
    width: 88,
    labelKey: 'library.songs',
    align: 'end',
    sortKeys: ['songCount'],
    optional: true,
  },
  {
    key: 'duration',
    width: 64,
    labelKey: 'library.duration',
    align: 'end',
    sortKeys: ['duration'],
    optional: true,
  },
  {
    key: 'added',
    width: 104,
    labelKey: 'library.songFilter.added',
    align: 'end',
    sortKeys: ['added'],
    optional: true,
  },
  {
    key: 'rating',
    width: 112,
    labelKey: 'library.rating',
    align: 'end',
    sortKeys: ['rating'],
    optional: true,
    rated: true,
  },
  { key: 'star', width: 40, labelKey: null, align: 'start', sortKeys: [], optional: false },
]

export const OPTIONAL_ALBUM_COLUMNS = ALBUM_COLUMNS.filter((column) => column.optional)

/** The release type is off to begin with: most libraries are albums
 * throughout, and a column of the same word says nothing. */
export const DEFAULT_ALBUM_COLUMNS: AlbumColumnKey[] = [
  'genre',
  'year',
  'songCount',
  'duration',
  'added',
  'rating',
]

/** First to give way in a narrow list: the least asked-for first, the year
 * last. */
const ALBUM_DROP_ORDER: AlbumColumnKey[] = [
  'releaseType',
  'genre',
  'added',
  'rating',
  'duration',
  'songCount',
  'year',
]

/** The columns a list this wide draws out of the chosen ones. */
export function albumColumnsFor(
  chosen: readonly AlbumColumnKey[],
  width: number,
  rated: boolean,
): AlbumColumn[] {
  return fitListColumns(resolveListColumns(ALBUM_COLUMNS, chosen, rated), width, ALBUM_DROP_ORDER)
}
