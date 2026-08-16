import { fetchConnect } from './http'

/** Peak-amplitude data for a track's waveform seek bar (connect/routes/waveform.py).
 * No caching here — the backend recomputes peaks fresh on every request
 * (see connect/core/waveform.py: a one-shot decode is well under a second,
 * not worth a cache for), and TrackWaveform.vue already skips re-calling
 * this for a track it's already fetched via its own fetchedTrackId guard. */
export async function getWaveform(trackId: string): Promise<number[]> {
  const result = await fetchConnect<{ peaks: number[] }>(`/waveform/${trackId}`)
  return result.peaks
}
