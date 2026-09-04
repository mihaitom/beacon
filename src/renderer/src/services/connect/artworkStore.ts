/** Artwork that survives a reload — the on-disk half of coverArtBatch.ts's
 * cache.
 *
 * The memory cache next door makes browsing back and forth free for as long
 * as the page lives. This one covers what that cannot: a browser reload, a
 * second tab, tomorrow morning. It matters most in the Docker/web build,
 * where the app *is* a page and reloading it is a normal thing to do, and
 * where every cover it re-asks for crosses the reverse proxy twice.
 *
 * IndexedDB rather than the Cache Storage API, which would otherwise be the
 * obvious fit for "keep these image responses": Cache Storage only exists in
 * a secure context, and a self-hosted Beacon reached at http://192.168.x.y
 * is not one. IndexedDB has no such restriction, so it works exactly where
 * this is needed most. It is not available *everywhere* either — the
 * packaged desktop app loads its renderer from a file:// URL, where Chromium
 * denies IndexedDB outright, and a browser in private mode or with site data
 * blocked can refuse at any point. Every path here therefore degrades to
 * "no persistence" rather than failing: the desktop app carries its own
 * Beacon backend, whose cache (connect/routes/coverart.py) already answers
 * from memory on the same machine.
 *
 * Nothing here is on the critical path twice: a miss costs one indexed
 * lookup before the request that was going to happen anyway. */

const DB_NAME = 'beacon-artwork'
const DB_VERSION = 1
const STORE = 'images'

// How long a stored image stays good. The same month the rest of the app's
// artwork uses (connect/routes/coverart.py's own cache, and the
// Cache-Control the proxied image path hands the browser).
//
// Long, because expiry is not what keeps artwork current: a cover art id
// carries the version of the picture behind it, so re-tagging an album
// produces a different id and a different key here, and the stale entry is
// simply never asked for again. The expiry is the backstop for a server
// whose ids don't work that way — see connect/media/base.py's artwork_id
// for which do and why.
const TTL_MS = 30 * 24 * 60 * 60 * 1000

// How much disk to use at most, oldest evicted first. A large library
// browsed thoroughly would otherwise grow this without limit.
//
// Measured in bytes rather than in images, because "3000 images" says
// nothing about the space they take: three thousand list-row thumbnails are
// under ten megabytes, three thousand Now Playing covers are a few hundred,
// and three thousand artist photos would be more than a gigabyte. 250 MB is
// well within what a browser grants an origin, and holds a large library's
// covers at every size the app asks for (see CoverArt.vue's FETCH_SIZES).
const MAX_BYTES = 250 * 1024 * 1024

// Anything larger is used, but not stored — a single oversized artist photo
// is not worth a noticeable share of the budget above, and the memory cache
// still covers it for this session.
const MAX_RECORD_BYTES = 2 * 1024 * 1024

// How many writes to let by between maintenance passes. Trimming on every
// write would mean an index walk per cover; skipping it entirely would let
// the store grow past MAX_BYTES between reloads. A screenful of covers is
// dozens of writes, so this is a handful of passes per browsing session.
const WRITES_PER_MAINTENANCE = 200

interface StoredArtwork {
  key: string
  blob: Blob
  savedAt: number
  /** blob.size, kept alongside it so the budget above can be enforced
   * without reading the images themselves back out. */
  bytes: number
}

let database: Promise<IDBDatabase | null> | null = null
let writesSinceMaintenance = 0
// Bumped by clear(). A read or write that started before a wipe must not
// resurrect what the wipe was for (another account's artwork), so anything
// that crosses one is dropped on the floor.
let generation = 0

/** The open database, or null if this browser won't give us one. Opened
 * once and reused; a failure is remembered as "no persistence" rather than
 * retried per request, since every reason for it (file:// origin, blocked
 * site data, private mode) lasts as long as the page does. */
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
        // Everything this store has to do in bulk — drop what has expired,
        // drop the oldest when there are too many — is "in the order they
        // were stored", so that order is the one index it keeps.
        store.createIndex('savedAt', 'savedAt')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      // Another tab is holding an older version open. Rather than wait for
      // it, this tab simply goes without — artwork is not worth blocking on.
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return database
}

/** Runs one request inside its own transaction, resolving to null for
 * anything that goes wrong. Storage is a convenience here, never a
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

/** The stored image for `key`, or null — for a miss, for an entry that has
 * aged out, and for a browser that has no store to read from. */
export async function readArtwork(key: string): Promise<Blob | null> {
  const started = generation
  const db = await open()
  if (!db) return null
  const record = (await run<StoredArtwork | undefined>(db, 'readonly', (store) =>
    store.get(key),
  )) as StoredArtwork | undefined | null
  if (!record || started !== generation) return null
  if (Date.now() - record.savedAt > TTL_MS) {
    void run(db, 'readwrite', (store) => store.delete(key))
    return null
  }
  return record.blob
}

/** Stores an image for next time. Fire-and-forget: the caller already has
 * the bytes it needs, and nothing it does depends on this landing.
 *
 * Only images are stored, never a remembered "this has no artwork" — that
 * answer is kept in memory for the session (see coverArtBatch.ts) but not
 * on disk, so a library scan that fills in the missing art shows up on the
 * next reload rather than being masked by a stale "there is none". */
export function writeArtwork(key: string, blob: Blob): void {
  if (blob.size > MAX_RECORD_BYTES) return
  const started = generation
  void (async () => {
    const db = await open()
    if (!db || started !== generation) return
    await run(db, 'readwrite', (store) =>
      store.put({ key, blob, savedAt: Date.now(), bytes: blob.size }),
    )
    writesSinceMaintenance += 1
    if (writesSinceMaintenance >= WRITES_PER_MAINTENANCE) {
      writesSinceMaintenance = 0
      await maintain(db)
    }
  })()
}

/** Throws away everything stored. Called when the account changes: cover
 * ids are only unique within one media server, so another account's
 * library must not be shown this one's artwork. */
export function clearArtwork(): void {
  generation += 1
  void (async () => {
    const db = await open()
    if (!db) return
    await run(db, 'readwrite', (store) => store.clear())
  })()
}

/** Drops what has expired, then whatever no longer fits in the budget.
 * `budget` is a parameter only so a test can fill the store without
 * writing a quarter of a gigabyte first. */
async function maintain(db: IDBDatabase, budget: number = MAX_BYTES): Promise<void> {
  await expire(db)
  await trimToBudget(db, budget)
}

/** Deletes everything stored longer ago than the TTL. Walks the savedAt
 * index, which is ordered oldest-first, so it stops at the first entry that
 * is still good. */
function expire(db: IDBDatabase): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const index = transaction.objectStore(STORE).index('savedAt')
      // openKeyCursor, not openCursor: this only needs to know *which*
      // records to delete, and reading the values would pull every image it
      // walks past out of storage just to throw it away.
      const request = index.openKeyCursor(IDBKeyRange.upperBound(Date.now() - TTL_MS))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        transaction.objectStore(STORE).delete(cursor.primaryKey)
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

/** Keeps the newest entries that fit in `budget` and deletes the rest.
 *
 * Walks the savedAt index backwards, newest first, adding up what it has
 * kept — the moment the budget is used up, everything older than that point
 * goes. One pass, and no need to total the store up first. It reads values
 * rather than keys alone (unlike expire above) because the byte count lives
 * in the record; the images themselves stay in storage, since a Blob read
 * out of IndexedDB is a handle to it rather than its contents. */
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
        const bytes = (cursor.value as StoredArtwork | undefined)?.bytes ?? 0
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
// what it does can only be checked from inside it. These four are what
// artworkStore.browser.test.ts (a real browser, for a real IndexedDB) uses;
// nothing in the app calls them.

/** The open database and the counters outlive any one test. */
export async function _resetArtworkStore(): Promise<void> {
  const db = await open()
  if (db) {
    await run(db, 'readwrite', (store) => store.clear())
    db.close()
  }
  database = null
  writesSinceMaintenance = 0
  generation = 0
}

/** Puts records in directly, timestamps included — both to age an entry
 * without waiting a day for it, and to fill the store past MAX_RECORDS in
 * one transaction rather than in thousands of separate writes. */
export async function _seedForTest(records: Omit<StoredArtwork, 'bytes'>[]): Promise<void> {
  const db = await open()
  if (!db) throw new Error('no IndexedDB in this environment')
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    for (const record of records) store.put({ ...record, bytes: record.blob.size })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

/** Runs the maintenance pass that normally only happens every
 * WRITES_PER_MAINTENANCE writes, optionally against a smaller budget than
 * the real one. */
export async function _maintainNow(budget?: number): Promise<void> {
  const db = await open()
  if (db) await maintain(db, budget)
}

/** How many records are stored right now. */
export async function _countForTest(): Promise<number> {
  const db = await open()
  if (!db) return 0
  return (await run<number>(db, 'readonly', (store) => store.count())) ?? 0
}
