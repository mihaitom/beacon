import { fetchConnect } from './http'

interface PendingRequest {
  resolve: (blob: Blob) => void
  reject: (reason: unknown) => void
}

interface CoverArtBatchResponse {
  results: Record<string, string | null>
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
// own cap silently truncating it.
const MAX_BATCH_SIZE = 200

// Module-wide, not per-component-instance, same reasoning as CoverArt.vue's
// own `inFlight`/`waiting` — every cover in the app shares one set of
// in-flight batches, grouped by requested size since one HTTP call asks the
// backend for one size.
let pendingBySize = new Map<number, Map<string, PendingRequest[]>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Resolves to the requested cover's image bytes, or rejects — with a
 * DOMException named 'AbortError' if `signal` fires before the result
 * arrives (immediately, with no network cost at all, if it fires before
 * this request's batch has even been sent), otherwise a plain Error if the
 * batch came back with no usable art for this id. Mirrors the contract a
 * caller used to get from `fetch(url, {signal}).then(r => r.blob())`,
 * since that's what this replaced inside CoverArt.vue's loadCandidates(). */
export function fetchCoverArtBatched(id: string, size: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let byId = pendingBySize.get(size)
    if (!byId) {
      byId = new Map()
      pendingBySize.set(size, byId)
    }
    let requests = byId.get(id)
    if (!requests) {
      requests = []
      byId.set(id, requests)
    }
    const request: PendingRequest = { resolve, reject }
    requests.push(request)

    signal.addEventListener(
      'abort',
      () => {
        const at = requests!.indexOf(request)
        if (at >= 0) requests!.splice(at, 1)
        // Nobody left waiting on this id — drop it from the pending batch
        // entirely so a flush that hasn't happened yet never sends it at
        // all, instead of sending it and simply discarding the answer.
        if (requests!.length === 0) byId!.delete(id)
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

function flush(): void {
  flushTimer = null
  const batches = pendingBySize
  pendingBySize = new Map()
  for (const [size, byId] of batches) {
    const ids = [...byId.keys()]
    for (let offset = 0; offset < ids.length; offset += MAX_BATCH_SIZE) {
      void sendBatch(size, ids.slice(offset, offset + MAX_BATCH_SIZE), byId)
    }
  }
}

async function sendBatch(
  size: number,
  ids: string[],
  byId: Map<string, PendingRequest[]>,
): Promise<void> {
  let results: Record<string, string | null>
  try {
    const response = await fetchConnect<CoverArtBatchResponse>('/cover-art/batch', {
      method: 'POST',
      body: { ids, size },
    })
    results = response.results
  } catch (error) {
    for (const id of ids) settle(byId, id, null, error)
    return
  }
  for (const id of ids) {
    const dataUrl = results[id]
    if (!dataUrl) {
      settle(byId, id, null, new Error(`No cover art for ${id}`))
      continue
    }
    try {
      settle(byId, id, dataUrlToBlob(dataUrl), undefined)
    } catch (error) {
      settle(byId, id, null, error)
    }
  }
}

function settle(
  byId: Map<string, PendingRequest[]>,
  id: string,
  blob: Blob | null,
  error: unknown,
): void {
  const requests = byId.get(id)
  if (!requests) return
  for (const request of requests) {
    if (blob) request.resolve(blob)
    else request.reject(error)
  }
}

// Decoded by hand (not `await (await fetch(dataUrl)).blob()`) so this never
// touches the global fetch — a `data:` URL isn't a real network request,
// and routing it through fetch anyway would make every batched cover show
// up as a second, synthetic "request" to anything (including a test) that
// observes fetch calls to account for network activity.
function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, commaIndex)
  const mime = /data:(.*?);base64/.exec(header)?.[1] ?? 'application/octet-stream'
  const binary = atob(dataUrl.slice(commaIndex + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
