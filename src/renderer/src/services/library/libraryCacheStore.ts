/** Where the library catalog is kept between runs of the app: the album
 * list, the artist list, the playlist list, and the full song catalog.
 *
 * This used to be a single JSON blob in `localStorage` under one key, and
 * that had a hard ceiling it was quietly running into. localStorage is
 * capped at roughly 5 MB per origin; a library of 1,200 albums and 15,000
 * songs already serializes to 4.26 MB (measured), and every field lived in
 * the *same* blob — so one large catalog put all four over the edge
 * together. Past that point `setItem` throws, the write is dropped, and
 * nothing is cached at all: every start of the app re-fetches the entire
 * library from the music server. Silently, and permanently, for exactly the
 * libraries where that fetch costs the most.
 *
 * It hurt worst on Jellyfin, where the catalog scan is slow by nature (see
 * fetchAllSongsNow()'s own measurements — roughly 9ms per item on a real
 * server, minutes for a large library), which is precisely the case where a
 * cache that never persists is most expensive.
 *
 * IndexedDB has no such ceiling, stores structured data without a
 * serialization round trip of the caller's own, and gives each field its own
 * record — so writing the albums no longer rewrites the song catalog beside
 * them. It is also available everywhere this app runs, including the
 * packaged desktop build: Electron grants IndexedDB to its `file://`
 * renderer (verified against the real binary, not assumed).
 *
 * If it is unavailable anyway — a browser in private mode, site data blocked
 * — nothing is persisted and nothing breaks: the library is simply fetched
 * on each start, which is what a first run does regardless. */

const DB_NAME = 'beacon-library'
const DB_VERSION = 1
const STORE = 'fields'

/** The old single-blob key, still read once per account to carry an
 * existing cache over (see migrateLegacyCache in stores/library.ts). */
export const LEGACY_CACHE_KEY = 'beacon.library-cache'

export interface StoredLibraryField<T> {
  items: T[]
  /** When this field was last actually fetched — the freshness check that
   * decides on a background refresh lives with the caller, which knows what
   * a sensible age is for the server it is talking to. */
  fetchedAt: number
}

let database: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (database) return database
  database = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      // Another tab holds an older version open. The library is fetchable
      // without a cache, so this tab goes without rather than waiting.
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return database
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      transaction.onabort = () => resolve(null)
      transaction.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** One field's cached contents, or null when there is none (and where
 * nothing can be stored at all). */
export async function readLibraryField<T>(key: string): Promise<StoredLibraryField<T> | null> {
  const db = await open()
  if (!db) return null
  const record = (await run(db, 'readonly', (store) => store.get(key))) as
    (StoredLibraryField<T> & { key: string }) | undefined | null
  if (!record) return null
  return { items: record.items, fetchedAt: record.fetchedAt }
}

/** Stores one field. Fire-and-forget: the caller already has the data, and
 * nothing it does depends on this landing.
 *
 * `fetchedAt` is passed in rather than stamped here, so carrying an older
 * cache over keeps its real age instead of looking freshly fetched. */
export function writeLibraryField<T>(key: string, items: T[], fetchedAt = Date.now()): void {
  void (async () => {
    const db = await open()
    if (!db) return
    // Structured-cloned as-is, with no JSON round trip: what used to make
    // one field's write cost the size of all four is exactly that step.
    await run(db, 'readwrite', (store) => store.put({ key, items, fetchedAt }))
  })()
}

/** Forgets the given fields — logout, or a library rescan. */
/** Resolves once the fields are actually gone — see clearArtwork()'s own
 * note for why that is worth waiting on. */
export function clearLibraryFields(keys: string[]): Promise<void> {
  return (async () => {
    const db = await open()
    if (!db) return
    for (const key of keys) await run(db, 'readwrite', (store) => store.delete(key))
  })()
}

/** Test seam — the open database outlives any one test. */
export async function _resetLibraryCacheStore(): Promise<void> {
  const db = await open()
  if (db) {
    await run(db, 'readwrite', (store) => store.clear())
    db.close()
  }
  database = null
}
