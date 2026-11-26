/** Sending the Strange Attractors preset straight to one system (the
 * Milkdrop menu's "Jump to") instead of waiting for the next change. Its
 * frame equations read `globalThis.beaconAttractorPick` - the system's
 * number - and fly over to that one at once. */
export const STRANGE_ATTRACTORS_KEY = 'builtin:beacon-strange-attractors'

export interface AttractorDestination {
  label: string
  /** The system's number in the preset: its row in the table, and one
   * less than its caption's. */
  system: number
}

export const ATTRACTOR_DESTINATIONS: AttractorDestination[] = [
  { label: 'Lorenz attractor', system: 0 },
  { label: 'Aizawa attractor', system: 1 },
  { label: 'Thomas attractor', system: 2 },
  { label: 'Halvorsen attractor', system: 3 },
  { label: 'Rössler attractor', system: 4 },
  { label: 'Hyperchaotic Lorenz system (4D)', system: 5 },
  { label: 'Chen attractor', system: 6 },
  { label: "Chua's circuit", system: 7 },
  { label: 'Dadras attractor', system: 8 },
]

export function jumpToSystem(destination: AttractorDestination): void {
  ;(globalThis as { beaconAttractorPick?: number | null }).beaconAttractorPick = destination.system
}
