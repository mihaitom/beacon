/** The rating order the album and artist lists share, and the index-bar
 * sections it files an item under: one per star count, then the unrated. */

/** The section an unrated item goes under. Last in the bar, where the list
 * puts those items. */
export const UNRATED_SECTION = '–'

export const RATING_SECTIONS = ['5', '4', '3', '2', '1', UNRATED_SECTION]

/** Most stars first, unrated last. Array.prototype.sort is stable, so items
 * with the same rating keep the order they were given in - the server's
 * alphabetical one for both lists. */
export function sortByRating<T extends { rating: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.rating - a.rating)
}

export function ratingSection(item: { rating: number }): string {
  return item.rating > 0 ? String(item.rating) : UNRATED_SECTION
}

/** A rating section's divider text: the stars themselves, which need no
 * translation, or the locale's word for unrated. */
export function ratingSectionLabel(section: string, t: (key: string) => string): string {
  const stars = Number(section)
  return stars > 0 ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : t('library.unrated')
}
