/** The beat a preset can follow instead of guessing at one from the bass
 * itself: connect's analysis of the song, the one the room lights play
 * along with (services/milkdrop/songBeats.ts). Store-free, so the party
 * guest page can carry the visualizer without it. */

export interface BeatNow {
  /** The number of the last beat by now; a new number is a new beat. */
  index: number
  /** 0-1: how strongly that beat is heard - 0 through a breakdown. */
  strength: number
}

/** Handed to the preset's frame equations as `globalThis.beaconBeat`,
 * read the way the jumps hand theirs (fractalZoomJumps.ts). Null leaves a
 * preset to its own beat detection. */
export function showBeat(beat: BeatNow | null): void {
  ;(globalThis as { beaconBeat?: BeatNow | null }).beaconBeat = beat
}
