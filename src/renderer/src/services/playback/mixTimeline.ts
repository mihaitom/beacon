/** Which song a mix plays at which stream time - the frontend's half of
 * connect/core/mix_timeline.py. A mix is one stream through song after
 * song; the player only knows how far into that stream it is, and this
 * turns that back into the song and the position in it. */

export interface MixTimelineEntry {
  /** Stream seconds from which this entry holds. */
  t: number
  /** null after the first entry: the mix has ended. */
  song_id: string | null
  queue_index: number | null
  /** Seconds into the song at `t`. */
  position: number
  /** false: held - the song stands still while silence plays. */
  playing: boolean
  /** Song seconds per stream second (1 unless being stretched). */
  rate: number
  /** The song begins here, as opposed to going on after a hold. */
  start: boolean
}

export interface MixHeard {
  songId: string
  queueIndex: number
  position: number
  /** Stream time this play of the song began - changes when the same song
   * starts over (repeat-one), which its id and index cannot show. */
  startedAt: number
}

/** What plays at stream time `t`, or null before the first entry and once
 * the mix has ended. */
export function heardAt(timeline: readonly MixTimelineEntry[], t: number): MixHeard | null {
  let i = -1
  for (let j = 0; j < timeline.length && timeline[j]!.t <= t; j++) i = j
  if (i < 0) return null
  const entry = timeline[i]!
  if (entry.song_id === null || entry.queue_index === null) return null
  let startedAt = entry.t
  for (let j = i; j >= 0; j--) {
    const e = timeline[j]!
    if (e.song_id !== entry.song_id || e.queue_index !== entry.queue_index) break
    startedAt = e.t
    if (e.start) break
  }
  const position = entry.playing ? entry.position + (t - entry.t) * entry.rate : entry.position
  return { songId: entry.song_id, queueIndex: entry.queue_index, position, startedAt }
}

/** How far the song heard at stream time `t` is loaded, given the stream
 * is loaded up to stream time `end`: that song's own position at `end`, or
 * null once `end` lies past it - the rest of the song is in hand. 0 when
 * nothing is loaded or nothing is heard. */
export function loadedThrough(
  timeline: readonly MixTimelineEntry[],
  t: number,
  end: number,
): number | null {
  if (end <= 0) return 0
  const now = heardAt(timeline, t)
  if (!now) return 0
  const then = heardAt(timeline, end)
  if (!then || then.startedAt !== now.startedAt) return null
  return then.position
}
