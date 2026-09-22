/** For AlbumsView/ArtistsView/SongTable's AlphabetIndexBar. */

/** The bar letter a single name falls under: its first character uppercased,
 * or '#' for anything that isn't A-Z. */
export function letterForName(name: string): string {
  const char = name.trim().charAt(0).toUpperCase()
  return char >= 'A' && char <= 'Z' ? char : '#'
}

/** The bar letter an item belongs under. Uses the server's sort name where
 * it sends one, because the list is ordered by that, not by the display
 * name: Navidrome files "La Bête Blooms" under its sort name "bête blooms",
 * so the artist sits in the B section even though the name reads as L.
 * A server or bridge without sortName falls back to the name, which is
 * exactly the order those send. */
export function indexLetterFor(item: { name: string; sortName?: string | null }): string {
  return letterForName(item.sortName || item.name)
}

/** Maps each bar letter to the index of its first occurrence in the list.
 * Doesn't sort anything itself — every call site already holds its list in
 * the order the bar should follow (the server's own alphabetical order for
 * albums and artists, the title sort for songs); this just locates where
 * each letter's run starts within that existing order. */
export function firstIndexByLetter<T>(
  items: T[],
  letterOf: (item: T) => string,
): Map<string, number> {
  const map = new Map<string, number>()
  items.forEach((item, index) => {
    const letter = letterOf(item)
    if (!map.has(letter)) map.set(letter, index)
  })
  return map
}
