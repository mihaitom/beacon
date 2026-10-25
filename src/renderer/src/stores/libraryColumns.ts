import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import {
  DEFAULT_ALBUM_COLUMNS,
  OPTIONAL_ALBUM_COLUMNS,
  type AlbumColumnKey,
} from '@/services/library/albumColumns'
import {
  DEFAULT_ARTIST_COLUMNS,
  OPTIONAL_ARTIST_COLUMNS,
  type ArtistColumnKey,
} from '@/services/library/artistColumns'

export type LibraryList = 'album' | 'artist'

interface ColumnSelection {
  album: AlbumColumnKey[]
  artist: ArtistColumnKey[]
}

const LISTS: Record<
  LibraryList,
  { storageKey: string; known: Set<string>; defaults: readonly string[] }
> = {
  album: {
    storageKey: 'beacon.album-columns',
    known: new Set(OPTIONAL_ALBUM_COLUMNS.map((column) => column.key)),
    defaults: DEFAULT_ALBUM_COLUMNS,
  },
  artist: {
    storageKey: 'beacon.artist-columns',
    known: new Set(OPTIONAL_ARTIST_COLUMNS.map((column) => column.key)),
    defaults: DEFAULT_ARTIST_COLUMNS,
  },
}

/** Only columns this build has, once each - see stores/songColumns.ts's
 * sanitize(), which this follows. */
export function sanitizeColumns(list: LibraryList, keys: unknown): string[] | null {
  if (!Array.isArray(keys)) return null
  const known = LISTS[list].known
  return [
    ...new Set(keys.filter((key): key is string => typeof key === 'string' && known.has(key))),
  ]
}

function load(list: LibraryList): string[] {
  try {
    const raw = localStorage.getItem(accountScopedKey(LISTS[list].storageKey))
    return (raw ? sanitizeColumns(list, JSON.parse(raw)) : null) ?? [...LISTS[list].defaults]
  } catch {
    return [...LISTS[list].defaults]
  }
}

function loadAll(): ColumnSelection {
  return {
    album: load('album') as AlbumColumnKey[],
    artist: load('artist') as ArtistColumnKey[],
  }
}

/** Which optional columns the album and artist lists show - the
 * counterpart of stores/songColumns.ts, one selection per list for the
 * whole app, synced with the account like the song table's. */
export const useLibraryColumnsStore = defineStore('libraryColumns', {
  state: (): ColumnSelection => loadAll(),
  actions: {
    setColumns(list: LibraryList, keys: readonly string[]): void {
      const columns = sanitizeColumns(list, [...keys]) ?? [...LISTS[list].defaults]
      this.$patch({ [list]: columns })
      this.persist(list)
    },

    toggle(list: LibraryList, key: string): void {
      if (!LISTS[list].known.has(key)) return
      const current: string[] = this[list]
      this.setColumns(
        list,
        current.includes(key) ? current.filter((existing) => existing !== key) : [...current, key],
      )
    },

    reset(list: LibraryList): void {
      this.setColumns(list, LISTS[list].defaults)
    },

    persist(list: LibraryList): void {
      try {
        localStorage.setItem(accountScopedKey(LISTS[list].storageKey), JSON.stringify(this[list]))
      } catch {
        // Non-critical - the choice just doesn't survive to the next launch.
      }
      // Dynamic import for the same reason as stores/songColumns.ts.
      const field = list === 'album' ? 'albumColumns' : 'artistColumns'
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ [field]: this[list] }).catch(() => {}),
      )
    },

    /** See stores/songColumns.ts's reloadForAccount(). */
    reloadForAccount(): void {
      this.$patch(loadAll())
    },
  },
})
