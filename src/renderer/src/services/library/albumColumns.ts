/** The columns of the album list in its list form - one definition for the
 * rows (AlbumCard.vue with `row`) and the labels over them
 * (LibraryListHeader.vue), so the two cannot drift apart. */

import type { AlbumSortKey } from '@/services/albumSort'

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

export interface AlbumColumn {
  key: AlbumColumnKey
  width: string
  labelKey: string | null
  align: 'start' | 'end'
  /** The orders this column stands for, lit in the header while one is on. */
  sortKeys: AlbumSortKey[]
  /** The list width from which the column is shown. The name is what a row
   * is for, so the extras give way first, the least asked-for first. */
  showFrom: number
}

export const ALBUM_COLUMNS: AlbumColumn[] = [
  { key: 'cover', width: '44px', labelKey: null, align: 'start', sortKeys: [], showFrom: 0 },
  {
    key: 'name',
    width: 'minmax(0, 1fr)',
    labelKey: null,
    align: 'start',
    sortKeys: ['name', 'artist'],
    showFrom: 0,
  },
  {
    key: 'genre',
    width: '120px',
    labelKey: 'library.genre',
    align: 'start',
    sortKeys: [],
    showFrom: 960,
  },
  {
    key: 'releaseType',
    width: '96px',
    labelKey: 'library.albumColumnType',
    align: 'start',
    sortKeys: [],
    showFrom: 1100,
  },
  {
    key: 'year',
    width: '56px',
    labelKey: 'library.year',
    align: 'end',
    sortKeys: ['year'],
    showFrom: 0,
  },
  {
    key: 'songCount',
    width: '88px',
    labelKey: 'library.songs',
    align: 'end',
    sortKeys: ['songCount'],
    showFrom: 0,
  },
  {
    key: 'duration',
    width: '64px',
    labelKey: 'library.duration',
    align: 'end',
    sortKeys: ['duration'],
    showFrom: 0,
  },
  {
    key: 'added',
    width: '104px',
    labelKey: 'library.songFilter.added',
    align: 'end',
    sortKeys: ['added'],
    showFrom: 820,
  },
  {
    key: 'rating',
    width: '112px',
    labelKey: 'library.rating',
    align: 'end',
    sortKeys: ['rating'],
    showFrom: 640,
  },
  { key: 'star', width: '40px', labelKey: null, align: 'start', sortKeys: [], showFrom: 0 },
]

/** The columns a list this wide shows. Before the list has been measured
 * (width 0) only the ones that are always there. */
export function albumColumnsFor(width: number, rated: boolean): AlbumColumn[] {
  return ALBUM_COLUMNS.filter(
    (column) => (column.key !== 'rating' || rated) && width >= column.showFrom,
  )
}

export function albumColumnTemplate(columns: AlbumColumn[]): string {
  return columns.map((column) => column.width).join(' ')
}
