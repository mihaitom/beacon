import { fetchConnect } from './http'

/**
 * What the source file for a track actually is, as ffmpeg sees it.
 *
 * The stream-info panel shows the same things for local playback as it does
 * for a cast, and the media server's own metadata isn't enough for that: a
 * `Song` carries `format` and `bitRate`, but no sample rate and no bit
 * depth. Those come from a probe, which only connect can run — hence a
 * round trip for something that looks like it should already be in hand.
 *
 * Deliberately only the *source*. What's being played back is this app's own
 * quality setting (see services/streamQuality.ts), already known here; asking
 * connect for it too would put the same decision in two places.
 */
export interface LocalSourceInfo {
  source_codec: string | null
  source_sample_rate: number | null
  source_bit_depth: number | null
  source_bitrate_kbps: number | null
}

export async function fetchLocalSourceInfo(trackId: string): Promise<LocalSourceInfo> {
  return fetchConnect<LocalSourceInfo>(`/stream/local/${encodeURIComponent(trackId)}/info`)
}
