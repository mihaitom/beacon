import { fetchConnect } from './http'

/** Peak-amplitude data for a song's waveform seek bar (connect/routes/waveform.py).
 * No caching here — the backend recomputes peaks fresh on every request
 * (see connect/core/waveform.py: a one-shot decode is well under a second,
 * not worth a cache for), and SongWaveform.vue already skips re-calling
 * this for a song it's already fetched via its own fetchedSongId guard. */
export async function getWaveform(songId: string): Promise<number[]> {
  const result = await fetchConnect<{ peaks: number[] }>(`/waveform/${songId}`)
  return result.peaks
}
