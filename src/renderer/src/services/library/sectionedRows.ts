/** One entry of a virtualized library list: a section's divider, or a row
 * of up to `perRow` items (one for a list, a grid's width of tiles). */
export type SectionedEntry<T> =
  | { kind: 'section'; key: string; section: string }
  | { kind: 'row'; key: string; items: { item: T; index: number }[] }

/**
 * The list with a divider before each section's first item, the desktop's
 * letter dividers (AlbumsView.vue, SongTable.vue). A row never spans two
 * sections - the desktop learned that one: a row across a boundary left the
 * line half empty and the divider stuck in its middle.
 *
 * `index` is each item's place in the whole list, for whatever needs the
 * list around it (playing a favourite plays on after it). Without
 * `sectionOf` - an order that has no sections - it is rows alone.
 */
export function sectionedRows<T>(
  items: readonly T[],
  sectionOf: ((item: T) => string) | null,
  perRow: number,
  keyOf: (item: T) => string,
): SectionedEntry<T>[] {
  const entries: SectionedEntry<T>[] = []
  const width = Math.max(1, perRow)
  let previous: string | null = null
  let row: { item: T; index: number }[] = []
  const flush = () => {
    if (!row.length) return
    entries.push({ kind: 'row', key: `row-${keyOf(row[0]!.item)}`, items: row })
    row = []
  }
  items.forEach((item, index) => {
    const section = sectionOf ? sectionOf(item) : null
    if (section !== null && section !== previous) {
      flush()
      entries.push({ kind: 'section', key: `section-${index}-${section}`, section })
      previous = section
    }
    row.push({ item, index })
    if (row.length === width) flush()
  })
  flush()
  return entries
}
