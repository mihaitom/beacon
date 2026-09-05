/** Where fetched lyrics are kept between runs of the app.
 *
 * They used to live in one `localStorage` blob, which was the wrong place
 * for two reasons. localStorage is capped at about 5 MB per origin, and a
 * cache that grows by a few kilobytes per song played has no business
 * sitting in a fixed budget it shares with everything else the app persists
 * — the library catalog (several MB on a large library), the saved queue,
 * every setting. When that budget runs out, `setItem` throws and the write
 * is simply lost, and the loser may well be a *different* feature than the
 * one that filled it: a library cache that can no longer be written falls
 * back to re-fetching the whole catalog on every launch, which on Jellyfin
 * is a scan measured in minutes. The second reason follows from the first:
 * the whole blob had to be read and re-written on every single change,
 * because that is the only shape localStorage has.
 *
 * IndexedDB has neither problem — one record per song, a budget of its own,
 * and no 5 MB ceiling — and it is what the artwork cache
 * (services/connect/artworkStore.ts) already uses, for the same reasons.
 *
 * It is not available everywhere, though, and that matters more here than
 * it does for artwork: a lookup that has to be made again goes out to three
 * third-party services. localStorage therefore stays as a fallback — with
 * the bound it never had, which was the whole problem — for a browser in
 * private mode or with site data blocked. (It was originally written for
 * the packaged desktop app too, on the assumption that its file:// renderer
 * had no IndexedDB. That turned out to be wrong: Electron grants it there,
 * verified against the real binary. The fallback is kept for the cases
 * where it genuinely applies.) Which backend is in use is decided once and
 * is invisible above this module.
 *
 * If neither is available (private mode, site data blocked), nothing is
 * persisted and nothing breaks: stores/lyrics.ts keeps its own in-memory
 * copy for the session, and the Beacon backend caches the same lookups for
 * every client (see connect/routes/lyrics.py).
 *
 * Records are keyed per account: unlike artwork, this is not wiped when
 * someone else logs in — two people sharing a browser each keep their own
 * lyrics, and switching back does not start from nothing. */

const DB_NAME = 'beacon-lyrics'
const DB_VERSION = 1
const STORE = 'entries'

// The fallback backend's single blob. Not the old `beacon.lyricsCache`,
// which stores/lyrics.ts still reads once to carry an existing cache over —
// a different shape (each entry carries when it was written, so the bound
// below has something to evict by) under a different name, so an upgrade
// that is later rolled back doesn't find a file it half-understands.
const LOCAL_KEY = 'beacon.lyricsStore'

// How many songs the fallback keeps. Deliberately modest: localStorage is
// one ~5 MB budget shared with the library catalog, the saved queue and
// every setting, and an unbounded cache in there is what this whole module
// exists to undo. At a few kilobytes per song this is on the order of one
// megabyte — enough that a normal listening history stays cached, small
// enough that it cannot starve anything else.
const MAX_LOCAL_ENTRIES = 500

// How much disk to use at most, oldest written evicted first.
//
// A song's lyrics are a couple of kilobytes, so this holds something like
// ten thousand of them — far past what anyone accumulates, which is the
// point: the bound exists so the cache cannot grow without limit, not to
// ration a resource that is actually scarce here. Measured in bytes rather
// than in songs for the same reason artwork is: a track with a 200-line
// synced sheet and one with four lines are not the same entry.
const MAX_BYTES = 32 * 1024 * 1024

// How many writes to let by between maintenance passes. Trimming on every
// write would mean an index walk per song played; never trimming would let
// the store drift past the budget between reloads.
const WRITES_PER_MAINTENANCE = 100

interface StoredEntry<T> {
  key: string
  value: T
  savedAt: number
  /** Serialized length of `value`, kept alongside it so the budget can be
   * enforced without reading every entry back out. */
  bytes: number
}

let database: Promise<IDBDatabase | null> | null = null
let writesSinceMaintenance = 0
// Bumped by clearLyricsStore(). A read or write that started before a wipe
// must not resurrect what the wipe was for.
let generation = 0

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
        if (db.objectStoreNames.contains(STORE)) return
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        // The one thing this has to do in bulk — drop the oldest when there
        // are too many bytes — is "in the order they were written".
        store.createIndex('savedAt', 'savedAt')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      // Another tab is holding an older version open. Rather than wait for
      // it, this tab goes without.
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return database
}

/** Runs one request inside its own transaction, resolving to null for
 * anything that goes wrong. Persistence is a convenience here, never a
 * correctness requirement, so no caller has to handle a failure. */
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

// ── The fallback: one bounded blob in localStorage ───────────────────────

type LocalBlob = Record<string, { value: unknown; savedAt: number }>

let localBlob: LocalBlob | null = null

function loadLocalBlob(): LocalBlob {
  if (!localBlob) {
    try {
      localBlob = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as LocalBlob
    } catch {
      localBlob = {}
    }
  }
  return localBlob
}

/** Writes the blob back, making room first if there are too many entries
 * and again if the browser says there isn't space — a full quota must not
 * turn into "nothing is ever persisted again", which is what the
 * unbounded version this replaces did. */
function saveLocalBlob(blob: LocalBlob): void {
  const oldestFirst = () => Object.entries(blob).sort(([, a], [, b]) => a.savedAt - b.savedAt)

  const entries = oldestFirst()
  for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_LOCAL_ENTRIES))) {
    delete blob[key]
  }
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(blob))
    return
  } catch {
    // Out of room, or storage disabled entirely. Drop the oldest quarter
    // and try once more before giving up for this write.
  }
  const remaining = oldestFirst()
  for (const [key] of remaining.slice(0, Math.ceil(remaining.length / 4))) delete blob[key]
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(blob))
  } catch {
    // Nothing more to do — the caller's own session copy still serves this
    // run, and the next write will try again against a smaller blob.
  }
}

// ── The API above both backends ──────────────────────────────────────────

/** What is stored under `key`, or null for a miss (and where nothing can be
 * stored at all). Entries have no lifetime of their own: lyrics for a
 * recording do not change, and what *does* expire — a remembered "nothing
 * found anywhere" — is decided by the caller, which knows the difference
 * (see stores/lyrics.ts). */
export async function readLyrics<T>(key: string): Promise<T | null> {
  const started = generation
  const db = await open()
  if (!db) return (loadLocalBlob()[key]?.value as T | undefined) ?? null
  const record = (await run<StoredEntry<T> | undefined>(db, 'readonly', (store) =>
    store.get(key),
  )) as StoredEntry<T> | undefined | null
  if (!record || started !== generation) return null
  return record.value
}

/** Stores an entry for next time. Fire-and-forget: the caller already has
 * what it needs, and nothing it does depends on this landing. */
export function writeLyrics<T>(key: string, value: T): void {
  const started = generation
  let bytes = 0
  try {
    bytes = JSON.stringify(value).length
  } catch {
    // Not serializable at all - neither backend would take it.
    return
  }
  void (async () => {
    const db = await open()
    if (started !== generation) return
    if (!db) {
      const blob = loadLocalBlob()
      blob[key] = { value, savedAt: Date.now() }
      saveLocalBlob(blob)
      return
    }
    await run(db, 'readwrite', (store) => store.put({ key, value, savedAt: Date.now(), bytes }))
    writesSinceMaintenance += 1
    if (writesSinceMaintenance >= WRITES_PER_MAINTENANCE) {
      writesSinceMaintenance = 0
      await trimToBudget(db, MAX_BYTES)
    }
  })()
}

/** Stores many entries at once — one transaction, or one blob write,
 * rather than one per entry. Only used to carry an existing cache over at
 * upgrade (see stores/lyrics.ts's migrateLegacyCache), where doing it one
 * at a time would rewrite the fallback's whole blob per song. */
export function writeManyLyrics<T>(entries: [string, T][]): void {
  if (entries.length === 0) return
  const started = generation
  const savedAt = Date.now()
  void (async () => {
    const db = await open()
    if (started !== generation) return
    if (!db) {
      const blob = loadLocalBlob()
      for (const [key, value] of entries) blob[key] = { value, savedAt }
      saveLocalBlob(blob)
      return
    }
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        for (const [key, value] of entries) {
          let bytes = 0
          try {
            bytes = JSON.stringify(value).length
          } catch {
            continue
          }
          store.put({ key, value, savedAt, bytes })
        }
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => resolve()
        transaction.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
    await trimToBudget(db, MAX_BYTES)
  })()
}

/** Throws away everything stored, for Settings' "clear caches" action.
 * Resolves once the store is actually empty — see artworkStore.ts's
 * clearArtwork() for why that is worth waiting on. */
export function clearLyricsStore(): Promise<void> {
  generation += 1
  localBlob = {}
  try {
    localStorage.removeItem(LOCAL_KEY)
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
  return (async () => {
    const db = await open()
    if (!db) return
    await run(db, 'readwrite', (store) => store.clear())
  })()
}

/** Keeps the newest entries that fit in `budget` and deletes the rest.
 *
 * Walks the savedAt index backwards, newest first, adding up what it has
 * kept — the moment the budget is used up, everything older goes. One pass,
 * with no need to total the store up first. */
function trimToBudget(db: IDBDatabase, budget: number): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const request = transaction.objectStore(STORE).index('savedAt').openCursor(null, 'prev')
      let kept = 0
      let full = false
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const bytes = (cursor.value as StoredEntry<unknown> | undefined)?.bytes ?? 0
        if (full || kept + bytes > budget) {
          full = true
          cursor.delete()
        } else {
          kept += bytes
        }
        cursor.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => resolve()
      transaction.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

// ── Test seams ───────────────────────────────────────────────────────────
// This module is nothing but I/O against a store nobody else can see, so
// what it does can only be checked from inside it. These are what
// lyricsStore.browser.test.ts (a real browser, for a real IndexedDB) uses;
// nothing in the app calls them.

/** The open database and the counters outlive any one test. */
export async function _resetLyricsStore(): Promise<void> {
  const db = await open()
  if (db) {
    await run(db, 'readwrite', (store) => store.clear())
    db.close()
  }
  database = null
  localBlob = null
  writesSinceMaintenance = 0
  generation = 0
}

/** Runs the maintenance pass that normally only happens every
 * WRITES_PER_MAINTENANCE writes, optionally against a smaller budget than
 * the real one. */
export async function _trimNow(budget: number = MAX_BYTES): Promise<void> {
  const db = await open()
  if (db) await trimToBudget(db, budget)
}

/** How many entries are stored right now, in whichever backend is in use. */
export async function _countForTest(): Promise<number> {
  const db = await open()
  if (!db) return Object.keys(loadLocalBlob()).length
  return (await run<number>(db, 'readonly', (store) => store.count())) ?? 0
}
