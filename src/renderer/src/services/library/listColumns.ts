/** The columns of the album and artist lists in their list form - the shape
 * both share, and how a list picks the ones it draws. One definition feeds
 * the rows (AlbumCard.vue/ArtistCard.vue with `row`) and the labels over
 * them (LibraryListHeader.vue), so the two cannot drift apart. The song
 * table has its own, richer version of the same idea (songColumns.ts). */

export interface ListColumn<K extends string = string> {
  key: K
  /** In px. Null for the name, which takes what the others leave. */
  width: number | null
  labelKey: string | null
  align: 'start' | 'end'
  /** The orders this column stands for, lit in the header while one is on. */
  sortKeys: readonly string[]
  /** The user's to switch on and off (stores/libraryColumns.ts). The cover,
   * the name and the heart make the row and are always there. */
  optional: boolean
  /** Only where the server keeps a 1-5 rating. */
  rated?: boolean
}

/** The name never gets narrower than this; columns give way first. */
const NAME_MIN_WIDTH = 200
// The rows' (and the header's) padding either side and the gap between cells.
const ROW_PADDING = 16
const COLUMN_GAP = 16

/** The structural columns plus the chosen optional ones, in the list's own
 * order whatever order they were picked in. */
export function resolveListColumns<K extends string>(
  columns: readonly ListColumn<K>[],
  chosen: readonly K[],
  rated: boolean,
): ListColumn<K>[] {
  return columns.filter(
    (column) => (!column.rated || rated) && (!column.optional || chosen.includes(column.key)),
  )
}

function rowWidth(columns: readonly ListColumn[]): number {
  const widths = columns.reduce((sum, column) => sum + (column.width ?? NAME_MIN_WIDTH), 0)
  return widths + COLUMN_GAP * Math.max(columns.length - 1, 0) + ROW_PADDING
}

/** The columns that fit into `availableWidth`, dropped in `dropOrder` until
 * they do. Only what is drawn gives way: the choice stays, and the column
 * comes back once the list is wide enough. A width of 0 is "not measured
 * yet" and keeps every column. */
export function fitListColumns<K extends string>(
  columns: ListColumn<K>[],
  availableWidth: number,
  dropOrder: readonly K[],
): ListColumn<K>[] {
  if (availableWidth <= 0) return columns
  let fitted = columns
  for (const key of dropOrder) {
    if (rowWidth(fitted) <= availableWidth) break
    fitted = fitted.filter((column) => column.key !== key)
  }
  return fitted
}

export function listColumnTemplate(columns: readonly ListColumn[]): string {
  return columns
    .map((column) => (column.width === null ? 'minmax(0, 1fr)' : `${column.width}px`))
    .join(' ')
}
