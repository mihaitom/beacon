/**
 * The master volume over several cast targets at once: what it shows, and
 * what each speaker is set to when it moves.
 *
 * Two ways to read "turn it up": put every speaker on the same level
 * ('equal' - rooms that drifted apart get evened out), or move them
 * together and keep the differences someone set up on purpose
 * ('relative'). Pure functions only; volumeControl.ts does the sending.
 */

export type GroupVolumeMode = 'equal' | 'relative'

/** What the master slider shows: the loudest speaker. Not an average -
 * that would move on its own whenever one speaker hits 0 or 100 while the
 * others keep going. In relative mode the loudest is also the one that
 * lands exactly on the slider's value. */
export function groupLevel(volumes: Iterable<number | null>): number | null {
  let level: number | null = null
  for (const volume of volumes) {
    if (volume != null && (level == null || volume > level)) level = volume
  }
  return level
}

/**
 * The levels a relative move scales from. Kept across moves for as long
 * as the speakers still sit where the last move put them, so pulling the
 * master down to 0 and back up restores the old differences instead of
 * leaving every speaker at the same level. Anyone setting a speaker on its
 * own (its slider, its own buttons) breaks that, and the next move starts
 * from the levels as they are then.
 */
export interface GroupAnchor {
  base: Map<string, number>
  baseLevel: number
  written: Map<string, number>
}

/** A Chromecast reports its level as a fraction and comes back off by one
 * after rounding; that is not someone having changed it. */
const READBACK_TOLERANCE = 1

function anchorStillHolds(anchor: GroupAnchor, current: Map<string, number>): boolean {
  if (anchor.written.size !== current.size) return false
  for (const [key, volume] of current) {
    const written = anchor.written.get(key)
    if (written == null || Math.abs(written - volume) > READBACK_TOLERANCE) return false
  }
  return true
}

/**
 * Each speaker's new level for a master move to `level`, keyed like
 * `current`. Speakers without a reading are left out of `current` by the
 * caller and so are not touched.
 */
export function planGroupVolume(
  current: Map<string, number>,
  level: number,
  mode: GroupVolumeMode,
  anchor: GroupAnchor | null,
): { volumes: Map<string, number>; anchor: GroupAnchor | null } {
  const target = Math.min(100, Math.max(0, Math.round(level)))
  const equal = () => new Map([...current.keys()].map((key) => [key, target]))
  if (mode === 'equal') return { volumes: equal(), anchor: null }

  const kept = anchor && anchorStillHolds(anchor, current) ? anchor : null
  const base = kept?.base ?? new Map(current)
  const baseLevel = kept?.baseLevel ?? groupLevel(base.values()) ?? 0
  // Everything at 0 has no proportions left to keep.
  if (baseLevel === 0) return { volumes: equal(), anchor: null }

  const volumes = new Map(
    [...base].map(([key, volume]) => [key, Math.round((volume * target) / baseLevel)]),
  )
  return { volumes, anchor: { base, baseLevel, written: volumes } }
}
