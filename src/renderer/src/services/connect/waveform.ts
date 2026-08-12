import { fetchConnect } from './http'

// Module-level de-dup cache — the backend already caches peaks to disk (see
// connect/core/waveform.py), but this avoids even the network round-trip
// when navigating back to a recently-played track within the same session.
const cache = new Map<string, number[]>()

/** Peak-amplitude data for a track's waveform seek bar (connect/routes/waveform.py). */
export async function getWaveform(trackId: string): Promise<number[]> {
  const cached = cache.get(trackId)
  if (cached) return cached
  const result = await fetchConnect<{ peaks: number[] }>(`/waveform/${trackId}`)
  // An empty result means the backend couldn't actually decode the track
  // (e.g. the connect session wasn't authenticated/configured yet — see
  // TrackWaveform.vue's retry, which is what this not-caching enables) —
  // not a real "this track has no waveform" answer worth remembering, since
  // `if (cached)` above would otherwise treat a cached `[]` (truthy in JS)
  // as a legitimate hit and never ask again for the rest of the session.
  if (result.peaks.length > 0) cache.set(trackId, result.peaks)
  return result.peaks
}
