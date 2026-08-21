/** For AlbumsView/ArtistsView's AlphabetIndexBar — maps each leading letter
 * (uppercased, '#' for anything not A-Z, matching AlphabetIndexBar.vue's own
 * letter set) to the index of its first occurrence in the list. Doesn't sort
 * anything itself — both call sites already get their data back
 * alphabetically by name (fetchAlbums()'s getAlbumList2 'alphabeticalByName',
 * fetchArtists()'s getArtists.view index), this just locates where each
 * letter's run starts within that existing order. */
export function firstIndexByLetter<T>(
  items: T[],
  nameOf: (item: T) => string,
): Map<string, number> {
  const map = new Map<string, number>()
  items.forEach((item, index) => {
    const char = nameOf(item).trim().charAt(0).toUpperCase()
    const letter = char >= 'A' && char <= 'Z' ? char : '#'
    if (!map.has(letter)) map.set(letter, index)
  })
  return map
}
