/** The artist list's columns in its list form - see listColumns.ts. */

import { fitListColumns, resolveListColumns, type ListColumn } from '@/services/library/listColumns'

export type ArtistColumnKey = 'cover' | 'name' | 'albumCount' | 'songCount' | 'rating' | 'actions'

export type ArtistColumn = ListColumn<ArtistColumnKey>

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
    key: 'albumCount',
    width: 96,
    labelKey: 'library.albums',
    align: 'end',
    sortKeys: ['albumCount'],
    optional: true,
  },
  {
    key: 'songCount',
    width: 96,
    labelKey: 'library.songs',
    align: 'end',
    sortKeys: [],
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
  // See albumColumns.ts's actions column.
  { key: 'actions', width: 72, labelKey: null, align: 'end', sortKeys: [], optional: false },
]

export const OPTIONAL_ARTIST_COLUMNS = ARTIST_COLUMNS.filter((column) => column.optional)

export const DEFAULT_ARTIST_COLUMNS: ArtistColumnKey[] = ['albumCount', 'songCount', 'rating']

const ARTIST_DROP_ORDER: ArtistColumnKey[] = ['rating', 'songCount', 'albumCount']

export function artistColumnsFor(
  chosen: readonly ArtistColumnKey[],
  width: number,
  rated: boolean,
): ArtistColumn[] {
  return fitListColumns(resolveListColumns(ARTIST_COLUMNS, chosen, rated), width, ARTIST_DROP_ORDER)
}
