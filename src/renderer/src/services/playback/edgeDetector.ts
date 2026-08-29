/** Edge-detects a boolean's false→true / true→false transition across
 * repeated reads of the same underlying value — behind lastEnded (connect
 * status.ended) and wasCastingActive (connect.isActive) in stores/playback.ts,
 * both "did this flip since the last time I looked, not just what is it
 * right now" checks (status.ended stays true on every subsequent status
 * tick until the next song starts, and would otherwise re-trigger
 * advanceOnSongEnd() every ~2s instead of once). */
export interface EdgeDetector {
  /** Feeds the latest value; returns which edge (if any) just happened
   * relative to `initial`/the previous update() — 'rising' (false→true),
   * 'falling' (true→false), or null if it matches whatever came before
   * (including a first call that matches `initial`). */
  update(value: boolean): 'rising' | 'falling' | null
}

export function createEdgeDetector(initial = false): EdgeDetector {
  let previous = initial
  return {
    update(value) {
      const edge = value === previous ? null : value ? 'rising' : 'falling'
      previous = value
      return edge
    },
  }
}
