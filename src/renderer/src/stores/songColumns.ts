import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import {
  DEFAULT_SONG_COLUMNS,
  OPTIONAL_SONG_COLUMNS,
  type SongColumnKey,
} from '@/services/library/songColumns'

const STORAGE_KEY = 'beacon.song-columns'

const KNOWN = new Set(OPTIONAL_SONG_COLUMNS.map((column) => column.key))

/** Keeps only columns this build actually has, and only once each. A
 * selection synced from a newer build (one with a column added since) must
 * not carry a key nothing here can draw - and, unlike the lyrics providers'
 * own sanitizer, an empty result needs no special case: switching every
 * optional column off is a perfectly good table. */
function sanitize(keys: unknown): SongColumnKey[] | null {
  if (!Array.isArray(keys)) return null
  const seen = new Set<SongColumnKey>()
  for (const key of keys) {
    if (typeof key === 'string' && KNOWN.has(key as SongColumnKey)) seen.add(key as SongColumnKey)
  }
  return [...seen]
}

function load(): SongColumnKey[] {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    // Absent, unparseable, or written by something else entirely: the
    // default set, not an empty table.
    return (raw ? sanitize(JSON.parse(raw)) : null) ?? [...DEFAULT_SONG_COLUMNS]
  } catch {
    return [...DEFAULT_SONG_COLUMNS]
  }
}

/**
 * Which optional columns every song table shows - one selection for the
 * whole app rather than one per page, so a column switched on in the
 * library is on in a playlist too.
 *
 * The order is never stored: a table draws its columns in
 * services/library/songColumns.ts's own order whatever order they were
 * picked in, so this only ever holds a set.
 */
export const useSongColumnsStore = defineStore('songColumns', {
  state: () => ({
    columns: load() as SongColumnKey[],
  }),
  actions: {
    setColumns(keys: readonly SongColumnKey[]): void {
      this.columns = sanitize([...keys]) ?? [...DEFAULT_SONG_COLUMNS]
      this.persist()
    },

    toggle(key: SongColumnKey): void {
      if (!KNOWN.has(key)) return
      this.columns = this.columns.includes(key)
        ? this.columns.filter((existing) => existing !== key)
        : [...this.columns, key]
      this.persist()
    },

    reset(): void {
      this.columns = [...DEFAULT_SONG_COLUMNS]
      this.persist()
    },

    persist(): void {
      try {
        localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(this.columns))
      } catch {
        // Non-critical - worst case the selection doesn't survive to the
        // next launch.
      }
      // Best-effort account sync, dynamic import to dodge the circular
      // import stores/radioSettings.ts documents.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ songColumns: this.columns }).catch(() => {}),
      )
    },

    /** Re-reads this account's own stored selection - state() only ever
     * runs once, at app boot, before login has resolved who's logged in.
     * Wired up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.columns = load()
    },
  },
})
