/** How a library half (songs, albums, artists) is browsed: which orders and
 * filters it offers, what it is sorted and filtered to, and the sections an
 * order files it under. The phone's library (MobileLibraryView.vue) and the
 * Remote Control's (connect/static/remote/js/views/library.js, answered in
 * services/remoteControl/commands.ts) are the same list, so they read it
 * from here rather than each keeping a copy of the rules. */

import {
  ALBUM_FILTER_FIELDS,
  ALBUM_SORT_KEYS,
  UNKNOWN_YEAR_SECTION,
  albumRangeField,
  defaultAlbumDirection,
  sectionFor as albumSectionFor,
  sectionsFor as albumSectionsFor,
  sortAlbums,
  type AlbumSort,
  type AlbumSortKey,
} from '@/services/albumSort'
import {
  ARTIST_SORT_KEYS,
  artistFilterFields,
  artistSectionField,
  artistSectionFor,
  artistSectionsFor,
  defaultArtistDirection,
  sortArtists,
  type ArtistSort,
  type ArtistSortKey,
} from '@/services/artistSort'
import {
  defaultDirection,
  filterFieldsFor,
  filterSongs,
  isRangeSectioned,
  sectionFn,
  sectionsFor as songSectionsFor,
  sortKeysFor,
  sortLabelKey,
  sortSongs,
  type SongSort,
  type SongSortKey,
} from '@/services/library/songBrowse'
import {
  filterItems,
  filterOptionLabel,
  filterOptionShortLabel,
  type FilterField,
  type FilterFieldDef,
  type LibraryFilters,
} from '@/services/library/libraryFilter'
import { ratingSectionLabel } from '@/services/ratingSort'
import { songColumn, type SongColumnKey } from '@/services/library/songColumns'
import { formatDate, formatDuration } from '@/services/library/songFormat'
import type { ArtistStatsOf } from '@/services/library/artistStats'
import type { ServerType } from '@/services/capabilities'
import type { Album, Artist, Song } from '@/types/library'

export type LibraryTab = 'songs' | 'albums' | 'artists'

export const LIBRARY_TABS: LibraryTab[] = ['songs', 'albums', 'artists']

export type AnySort = { key: string; direction: 'asc' | 'desc' }

export type LibraryItem = Song | Album | Artist

type Translate = (key: string, named?: Record<string, unknown>) => string

/** What the server and the catalogue allow: the orders and filters on
 * offer depend on all of it. */
export interface BrowseContext {
  serverType: ServerType | null
  /** The server keeps a 1-5 rating. */
  rated: boolean
  /** The server keeps favourites. */
  favorites: boolean
  /** The figures counted out of the song catalogue, for the artist orders
   * and filters that need them - nothing until it has arrived. */
  statsOf: ArtistStatsOf
}

export function sortKeysOf(view: LibraryTab, ctx: BrowseContext): string[] {
  const keys: string[] =
    view === 'artists'
      ? ARTIST_SORT_KEYS
      : view === 'albums'
        ? ALBUM_SORT_KEYS
        : sortKeysFor(ctx.serverType)
  return keys.filter((key) => key !== 'rating' || ctx.rated)
}

export function sortLabelKeyOf(view: LibraryTab, key: string): string {
  if (view === 'artists') return `library.artistSort.${key}`
  if (view === 'albums') return `library.albumSort.${key}`
  return sortLabelKey(key as SongSortKey)
}

/** The direction picking an order starts in. */
export function defaultDirectionOf(view: LibraryTab, key: string): 'asc' | 'desc' {
  if (view === 'artists') return defaultArtistDirection(key as ArtistSortKey)
  if (view === 'albums') return defaultAlbumDirection(key as AlbumSortKey)
  return defaultDirection(key as SongSortKey)
}

/** The order actually applied. A rating order remembered from a server
 * with stars reads as name or title on one without them, without being
 * forgotten for the other; so does an order this server has nothing for. */
export function effectiveSort(view: LibraryTab, sort: AnySort, ctx: BrowseContext): AnySort {
  if (sortKeysOf(view, ctx).includes(sort.key)) return sort
  return { key: view === 'songs' ? 'title' : 'name', direction: 'asc' }
}

/** The filter menu's fields for the half - a rating or favourite filter
 * only where the server keeps those. */
export function filterFieldsOf(view: LibraryTab, ctx: BrowseContext): FilterFieldDef<never>[] {
  const offered = (def: { field: FilterField }) =>
    (def.field !== 'rating' || ctx.rated) && (def.field !== 'starred' || ctx.favorites)
  if (view === 'artists') {
    return artistFilterFields(ctx.statsOf).filter(offered) as FilterFieldDef<never>[]
  }
  if (view === 'albums') return ALBUM_FILTER_FIELDS.filter(offered) as FilterFieldDef<never>[]
  // The songs' favourite filter has always been offered regardless: a
  // server without favourites marks every song "no", which the menu hides.
  return filterFieldsFor(ctx.serverType).filter(
    (def) => def.field !== 'rating' || ctx.rated,
  ) as FilterFieldDef<never>[]
}

export function sortItems(
  view: LibraryTab,
  items: LibraryItem[],
  sort: AnySort,
  ctx: BrowseContext,
): LibraryItem[] {
  if (view === 'artists') return sortArtists(items as Artist[], sort as ArtistSort, ctx.statsOf)
  if (view === 'albums') return sortAlbums(items as Album[], sort as AlbumSort)
  return sortSongs(items as Song[], sort as SongSort)
}

export function filterList(
  view: LibraryTab,
  sorted: LibraryItem[],
  filters: LibraryFilters,
  ctx: BrowseContext,
): LibraryItem[] {
  if (view === 'songs') return filterSongs(sorted as Song[], filters)
  return filterItems(sorted, filterFieldsOf(view, ctx) as FilterFieldDef<LibraryItem>[], filters)
}

/** Which section an item sits in under the order, or null for an order
 * without sections - the desktop's own rules, per half. */
export function sectionOfFn(
  view: LibraryTab,
  sort: AnySort,
  ctx: BrowseContext,
  now = Date.now(),
): ((item: LibraryItem) => string) | null {
  if (view === 'artists') {
    return (artist) => artistSectionFor(artist as Artist, sort as ArtistSort, ctx.statsOf, now)
  }
  if (view === 'albums') return (album) => albumSectionFor(album as Album, sort as AlbumSort, now)
  const section = sectionFn(sort.key as SongSortKey, now)
  return section ? (song) => section(song as Song) : null
}

/** Every section the index lists for this order, from the unfiltered list
 * so it keeps its shape while a filter greys parts of it out. */
export function barSectionsOf(
  view: LibraryTab,
  sorted: LibraryItem[],
  sort: AnySort,
  ctx: BrowseContext,
): string[] {
  if (view === 'artists') {
    return artistSectionsFor(sorted as Artist[], sort as ArtistSort, ctx.statsOf)
  }
  if (view === 'albums') return albumSectionsFor(sorted as Album[], sort as AlbumSort)
  if (!sectionFn(sort.key as SongSortKey)) return []
  return songSectionsFor(sorted as Song[], sort as SongSort)
}

function rangeFieldOf(view: LibraryTab, key: string): FilterField | null {
  if (view === 'artists') return artistSectionField(key as ArtistSortKey)
  if (view === 'albums') return albumRangeField(key as AlbumSortKey)
  return isRangeSectioned(key as SongSortKey) ? (key as FilterField) : null
}

/** A divider's text: the letter itself, or what a range or a rating reads
 * as - the desktop's labels (AlbumsView, ArtistsView, SongTable). */
export function sectionLabel(view: LibraryTab, key: string, section: string, t: Translate): string {
  if (key === 'rating') return ratingSectionLabel(section, t)
  const range = rangeFieldOf(view, key)
  if (range) return filterOptionLabel(range, section, t)
  if (key !== 'year') return section
  if (section === UNKNOWN_YEAR_SECTION) return t('library.unknownYear')
  return t('library.decade', { decade: section })
}

/** The index's short form of a section: the letter, or "80s" for a decade
 * where the divider says "1980s". */
export function sectionShortLabel(
  view: LibraryTab,
  key: string,
  section: string,
  t: Translate,
): string {
  const range = rangeFieldOf(view, key)
  return range ? filterOptionShortLabel(range, section, t) : section
}

/** How a value is written for the row's second line: in the reader's
 * language, with a plural where a count needs one. */
export interface DetailFormat {
  t: Translate
  /** `key`'s plural form for `count`, `{n}` filled with it. */
  plural: (key: string, count: number) => string
  locale: string
}

/** The stars a rating reads as, or null for none - an unrated item says
 * nothing rather than "Unrated" on every other row. */
function stars(rating: number | null | undefined): string | null {
  return rating && rating > 0 ? ratingSectionLabel(String(rating), () => '') : null
}

function songDetail(song: Song, key: string, format: DetailFormat): string | null {
  switch (key) {
    // The row's own two lines already are the title and the artist.
    case 'title':
    case 'artist':
      return null
    case 'album':
      return song.album || null
    case 'rating':
      return stars(song.rating)
    case 'playCount':
      return format.plural('home.playCount', song.playCount ?? 0)
    case 'bpm':
      return song.bpm ? `${song.bpm} BPM` : null
    case 'disc':
    case 'track': {
      const value = key === 'disc' ? song.discNumber : song.trackNumber
      return value ? `${format.t(songColumn(key)!.labelKey)} ${value}` : null
    }
    default: {
      const value = songColumn(key as SongColumnKey)?.text?.(song, format.locale)
      // The table's empty cell is a dash; on a row it is simply nothing.
      return value && value !== '—' ? value : null
    }
  }
}

function albumDetail(album: Album, key: string, format: DetailFormat): string | null {
  switch (key) {
    case 'year':
      return album.year ? String(album.year) : null
    case 'added':
      return formatDate(album.created, format.locale)
    case 'rating':
      return stars(album.rating)
    case 'songCount':
      return format.plural('favorites.countSongs', album.songCount ?? 0)
    case 'duration':
      return formatDuration(album.duration)
    default:
      return null
  }
}

function artistDetail(
  artist: Artist,
  key: string,
  format: DetailFormat,
  ctx: BrowseContext,
): string | null {
  if (key === 'rating') return stars(artist.rating)
  const stats = ctx.statsOf(artist)
  if (!stats) return null
  switch (key) {
    case 'songCount':
      return format.plural('favorites.countSongs', stats.songCount)
    case 'genre':
      return stats.genre
    case 'years': {
      const { firstYear, lastYear } = stats
      if (!firstYear) return null
      return lastYear && lastYear !== firstYear ? `${firstYear}–${lastYear}` : String(firstYear)
    }
    case 'duration':
      return `${(stats.duration / 3600).toLocaleString(format.locale, { maximumFractionDigits: 1 })} h`
    case 'playCount':
      return format.plural('home.playCount', stats.playCount)
    case 'lastPlayed':
      return formatDate(stats.lastPlayed, format.locale)
    case 'added':
      return formatDate(stats.added, format.locale)
    default:
      return null
  }
}

/** What the list is sorted by, for an item's second line - so a list put
 * in order of plays or of the date added says why each item is where it
 * is. Null where the order is what the row shows anyway (a name, a title,
 * an artist, an album count) or the item has no value for it. */
export function sortDetail(
  view: LibraryTab,
  key: string,
  item: LibraryItem,
  format: DetailFormat,
  ctx: BrowseContext,
): string | null {
  if (view === 'artists') return artistDetail(item as Artist, key, format, ctx)
  if (view === 'albums') return albumDetail(item as Album, key, format)
  return songDetail(item as Song, key, format)
}
