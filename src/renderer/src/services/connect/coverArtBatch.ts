import { fetchConnect } from './http'
import { dataUrlToBlob } from './dataUrl'
import { clearArtwork, readArtwork, writeArtwork } from './artworkStore'

interface PendingRequest {
  resolve: (blob: Blob) => void
  reject: (reason: unknown) => void
}

/** Everything one batch is still waiting on, keyed by what was asked for —
 * a cover id for the size-grouped buckets, a full URL for the artist
 * photos. Several components can be waiting on the same key (the same album
 * on screen twice, the player bar and Now Playing showing one track), which
 * is why each key holds a list. */
type Pending = Map<string, PendingRequest[]>

interface CoverArtBatchResponse {
  results: Record<string, string | null>
  image_results?: Record<string, string | null>
}

// How long to hold a newly-requested cover open for others to join the same
// batch before sending it - short enough to stay invisible (a burst of
// covers settling within one scroll-stop frame all land in the same
// request), long enough that everything CoverArt.vue's own load-slot queue
// lets through together (see its MAX_CONCURRENT_LOADS) becomes one HTTP
// call instead of up to twelve concurrent ones. That queue used to be sized
// against how many *separate* proxied requests a reverse proxy could
// absorb at once; collapsing them into one request is what this file is
// for — see connect/routes/coverart.py's own module docstring for the
// CrowdSec ban this traffic shape triggered on a real deployment.
const BATCH_WINDOW_MS = 20

// Mirrors _MAX_IDS in connect/routes/coverart.py — a batch larger than the
// server accepts would just have its tail dropped by it, so anything past
// this is split into a further request instead of relying on the server's
// own cap silently truncating it. Applies to each of the two lists.
const MAX_BATCH_SIZE = 200

// Mirrors _DEFAULT_SIZE in connect/routes/coverart.py. Only ever sent on a
// request that carries no cover ids at all (artist photos, which come at
// whatever size their host serves them) — the field is required by the
// endpoint but means nothing there without ids.
const UNUSED_SIZE = 300

// How much fetched artwork to keep in memory, across the whole app.
//
// This is what makes browsing back and forth free. The endpoint behind this
// file is a POST, so nothing on the way — not the browser's HTTP cache, not
// a reverse proxy — is allowed to cache its answer the way it cached the
// plain image GET this replaced. Without a cache here, every re-visit of a
// view re-fetched every cover it shows, which is exactly what it looked
// like: artwork reloading from scratch on each navigation.
//
// Bounded by bytes rather than by a count, since one entry is anything from
// a 5 KB thumbnail to a full-size artist photo. Blobs live outside the JS
// heap (Chromium spills large ones to disk on its own), so this is a budget
// for how much artwork stays instantly available, not for heap pressure.
//
// This is the fast half of the cache. The other half is on disk
// (artworkStore.ts), which is what carries artwork across a reload of the
// page — this one only lives as long as it does.
const MAX_CACHE_BYTES = 32 * 1024 * 1024

// Module-wide, not per-component-instance, same reasoning as CoverArt.vue's
// own `inFlight`/`waiting` — every cover in the app shares one set of
// in-flight batches, grouped by requested size since one HTTP call asks the
// backend for one size. Artist photos are grouped separately: they have no
// size to ask for, and they ride along with whichever size group goes out
// first rather than costing a request of their own.
let pendingBySize = new Map<number, Pending>()
let pendingImages: Pending = new Map()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// What has already been fetched, oldest first (a Map iterates in insertion
// order, and `remember` re-inserts on every hit — that is the whole LRU).
// A `null` value is a remembered "there is no artwork for this", kept for
// the same reason the backend keeps its own: without it, a view full of
// art-less songs re-asks for every one of them on every render.
const cached = new Map<string, Blob | null>()
let cachedBytes = 0

// Which account's artwork the caches currently hold. Bumped by
// clearCoverArtCache() below, and captured by every batch as it goes out, so
// an answer that was already on the wire when the account changed can be
// recognized as belonging to the previous one. Without that, its images were
// written into both caches (memory and disk) *after* the switch, under keys
// the new session reads — and cover ids are only unique within one media
// server, so on Plex (small integer ratingKeys) or two Subsonic servers that
// is one account being shown another's artwork.
let generation = 0

/** The album/song cover this id resolves to, or rejects — with a
 * DOMException named 'AbortError' if `signal` fires before the result
 * arrives (immediately, with no network cost at all, if it fires before
 * this request's batch has even been sent), a NoCoverArtError if the batch
 * came back with no art for this id, and a plain Error for anything that
 * might work later. Mirrors the contract a caller used to get from
 * `fetch(url, {signal}).then(r => r.blob())`, since that's what this
 * replaced inside CoverArt.vue's loadCandidates(). */
export function fetchCoverArtBatched(id: string, size: number, signal: AbortSignal): Promise<Blob> {
  // The bucket is resolved when this actually joins one, not now: looking
  // on disk first takes a moment, and the batch that was open at the moment
  // of asking may already have gone out by then.
  return enqueue(
    () => bucketForSize(size),
    coverKey(id, size),
    id,
    signal,
    () => new NoCoverArtError(),
  )
}

/** The artist photo at `url`, resolved by the backend rather than by the
 * browser. Same contract as fetchCoverArtBatched() above.
 *
 * These used to go straight into an <img> tag: the media server hands them
 * out as ready-made URLs, frequently on a third-party CDN that sends no
 * CORS headers, so JS was allowed to render them but not to read them.
 * Going through the backend puts them under everything the rest of the
 * app's artwork already gets — one request for a screenful instead of one
 * per artist, a cache on both ends, and a fetch that can actually be
 * cancelled when the row scrolls away. */
export function fetchArtistImageBatched(url: string, signal: AbortSignal): Promise<Blob> {
  return enqueue(
    () => pendingImages,
    imageKey(url),
    url,
    signal,
    () => new NoArtistImageError(),
  )
}

/** The batch answered, and this id has no artwork — a settled answer, not a
 * failure to retry. Named so CoverArt.vue can tell it apart from a backend
 * that was simply unreachable just now, the same way NoRadioFaviconError
 * does for a station's logo. */
export class NoCoverArtError extends Error {
  constructor() {
    super('No cover art for this id')
    this.name = 'NoCoverArtError'
  }
}

/** The artist has no photo — very common (most artists in a library have
 * none), and the reason CoverArt.vue falls through to the album cover
 * behind it. Settled, same as NoCoverArtError above. */
export class NoArtistImageError extends Error {
  constructor() {
    super('No image for this artist')
    this.name = 'NoArtistImageError'
  }
}

function coverKey(id: string, size: number): string {
  return `cover:${size}:${id}`
}

function imageKey(url: string): string {
  return `image:${url}`
}

function bucketForSize(size: number): Pending {
  let bucket = pendingBySize.get(size)
  if (!bucket) {
    bucket = new Map()
    pendingBySize.set(size, bucket)
  }
  return bucket
}

/** Answers `ref` from memory, then from disk, and only then by joining
 * whatever batch is next to go out. `key` is what the caches know it as,
 * `ref` what goes on the wire (a bare cover id, or a full photo URL). */
async function enqueue(
  bucketOf: () => Pending,
  key: string,
  ref: string,
  signal: AbortSignal,
  missing: () => Error,
): Promise<Blob> {
  if (signal.aborted) throw abortError()
  const memory = lookup(key)
  if (memory.hit) {
    if (memory.blob) return memory.blob
    throw missing()
  }

  const stored = await readArtwork(key)
  if (signal.aborted) throw abortError()
  if (stored) {
    // Held in memory as well now, so the second view of it this session
    // doesn't go back to disk either.
    remember(key, stored)
    return stored
  }
  // Reading from disk takes long enough for a batch already in flight to
  // have answered this in the meantime.
  const again = lookup(key)
  if (again.hit) {
    if (again.blob) return again.blob
    throw missing()
  }

  return join(bucketOf(), ref, signal)
}

/** Puts `ref` on the next batch and hands back what it resolves to. */
function join(bucket: Pending, ref: string, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let requests = bucket.get(ref)
    if (!requests) {
      requests = []
      bucket.set(ref, requests)
    }
    const request: PendingRequest = { resolve, reject }
    requests.push(request)

    signal.addEventListener(
      'abort',
      () => {
        const at = requests!.indexOf(request)
        if (at >= 0) requests!.splice(at, 1)
        // Nobody left waiting on this one — drop it from the pending batch
        // entirely so a flush that hasn't happened yet never sends it at
        // all, instead of sending it and simply discarding the answer.
        if (requests!.length === 0) bucket.delete(ref)
        reject(abortError())
      },
      { once: true },
    )

    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS)
  })
}

function abortError(): DOMException {
  return new DOMException('The cover art request was aborted', 'AbortError')
}

/** What memory has for `key`: whether it knows this one at all (a
 * remembered "there is no artwork" is a real answer and is also null), and
 * what it holds. A hit is moved to the young end, so the next eviction
 * takes something genuinely unused instead. */
function lookup(key: string): { hit: boolean; blob: Blob | null } {
  if (!cached.has(key)) return { hit: false, blob: null }
  const blob = cached.get(key) ?? null
  cached.delete(key)
  cached.set(key, blob)
  return { hit: true, blob }
}

function forget(key: string): void {
  const entry = cached.get(key)
  if (entry === undefined) return
  cached.delete(key)
  cachedBytes -= entry?.size ?? 0
}

function remember(key: string, blob: Blob | null): void {
  forget(key)
  cached.set(key, blob)
  cachedBytes += blob?.size ?? 0
  while (cachedBytes > MAX_CACHE_BYTES && cached.size > 1) {
    const oldest = cached.keys().next().value
    if (oldest === undefined) break
    forget(oldest)
  }
}

/** Drops everything held in memory — called when the account changes (see
 * services/accountScopedStores.ts). Cover ids are only unique within one
 * media server, so another account's library must not be answered out of
 * this one's artwork.
 *
 * That includes artwork not fetched yet: a batch still waiting for its
 * window, or already on the wire, was assembled from the previous account's
 * ids. Whoever is waiting on one is told so rather than left hanging — with
 * a plain Error, so CoverArt.vue treats it as worth another go (it is: the
 * same component asks again against the new account and gets its own
 * library's cover). */
export function clearCoverArtCache(): void {
  cached.clear()
  cachedBytes = 0
  generation += 1

  const abandoned = [...pendingBySize.values(), pendingImages]
  pendingBySize = new Map()
  pendingImages = new Map()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  for (const bucket of abandoned) abandon(bucket, [...bucket.keys()])

  clearArtwork()
}

/** Rejects everything still waiting in `bucket` for `refs` — an answer that
 * arrived for the wrong account, or a batch dropped before it was sent. */
function abandon(bucket: Pending, refs: string[]): void {
  for (const ref of refs) {
    settle(bucket, ref, null, new Error('The account changed while this artwork was loading'))
  }
}

function chunked(refs: string[]): string[][] {
  const chunks: string[][] = []
  for (let offset = 0; offset < refs.length; offset += MAX_BATCH_SIZE) {
    chunks.push(refs.slice(offset, offset + MAX_BATCH_SIZE))
  }
  return chunks
}

function flush(): void {
  flushTimer = null
  const bySize = pendingBySize
  pendingBySize = new Map()
  const images = pendingImages
  pendingImages = new Map()

  // Artist photos travel with the first request that goes out anyway,
  // rather than as a second one — a view showing artists (Home's shelves,
  // the artist grid) has both kinds on screen at the same moment, and one
  // request for the screenful is the entire point of this file.
  const imageChunks = chunked([...images.keys()])
  for (const [size, byRef] of bySize) {
    for (const ids of chunked([...byRef.keys()])) {
      void sendBatch(size, ids, byRef, imageChunks.shift() ?? [], images)
    }
  }
  for (const urls of imageChunks) {
    void sendBatch(UNUSED_SIZE, [], new Map(), urls, images)
  }
}

async function sendBatch(
  size: number,
  ids: string[],
  byId: Pending,
  urls: string[],
  byUrl: Pending,
): Promise<void> {
  const sentAt = generation
  let response: CoverArtBatchResponse
  try {
    response = await fetchConnect<CoverArtBatchResponse>('/cover-art/batch', {
      method: 'POST',
      body: { ids, image_urls: urls, size },
    })
  } catch (error) {
    // Nothing is remembered for a batch that never arrived: this says
    // nothing about whether the artwork exists, and caching it as "there
    // isn't any" would blank every cover in it for the rest of the session
    // over one bad moment.
    for (const id of ids) settle(byId, id, null, error)
    for (const url of urls) settle(byUrl, url, null, error)
    return
  }
  // The account changed while this was in flight — see clearCoverArtCache().
  // Nothing from it may reach either cache.
  if (sentAt !== generation) {
    abandon(byId, ids)
    abandon(byUrl, urls)
    return
  }
  deliver(
    ids,
    byId,
    response.results,
    (id) => coverKey(id, size),
    () => new NoCoverArtError(),
  )
  deliver(urls, byUrl, response.image_results ?? {}, imageKey, () => new NoArtistImageError())
}

function deliver(
  refs: string[],
  bucket: Pending,
  results: Record<string, string | null>,
  keyOf: (ref: string) => string,
  missing: () => Error,
): void {
  for (const ref of refs) {
    // Absent from the answer entirely, rather than present and null: the
    // backend could not fetch this one just now (the media server timed
    // out, refused, or answered 5xx) and is deliberately saying nothing
    // about whether it exists — see _FetchUnavailable in
    // connect/routes/coverart.py. Nothing is remembered for it, and the
    // plain Error is what makes CoverArt.vue try again later, where a
    // NoCoverArtError would have left the tile blank for the whole session.
    if (!(ref in results)) {
      settle(bucket, ref, null, new Error('Artwork could not be fetched just now'))
      continue
    }
    const dataUrl = results[ref]
    if (!dataUrl) {
      remember(keyOf(ref), null)
      settle(bucket, ref, null, missing())
      continue
    }
    try {
      const blob = dataUrlToBlob(dataUrl)
      const key = keyOf(ref)
      remember(key, blob)
      // Kept for the next run of the app as well, so a reload of the page
      // doesn't start from nothing. Deliberately only for images that
      // exist — see artworkStore.ts's writeArtwork().
      writeArtwork(key, blob)
      settle(bucket, ref, blob, undefined)
    } catch (error) {
      settle(bucket, ref, null, error)
    }
  }
}

function settle(bucket: Pending, ref: string, blob: Blob | null, error: unknown): void {
  const requests = bucket.get(ref)
  if (!requests) return
  bucket.delete(ref)
  for (const request of requests) {
    if (blob) request.resolve(blob)
    else request.reject(error)
  }
}

/** Test seam — the module-level cache and pending batches outlive any one
 * component, so a test that doesn't clear them is answered by the previous
 * one's fixtures. */
export function _resetCoverArtBatch(): void {
  pendingBySize = new Map()
  pendingImages = new Map()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  clearCoverArtCache()
}
