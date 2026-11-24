/** Sending the Milky Way preset straight to one kind of sight (the
 * Milkdrop menu's "Jump to") instead of waiting for the dice. Its frame equations read
 * `globalThis.beaconMilkyWayPick` - values for its random draws (r1..r11) -
 * jump at once when one is waiting, and use them for the next sight. */
export const MILKY_WAY_KEY = 'builtin:beacon-milky-way'

export interface MilkyWayDestination {
  label: string
  /** The draws that lead there: r1 the kind, the others its variants. */
  pick: Record<string, number>
}

// r9 0.8 keeps a companion star away wherever one could come up.
export const MILKY_WAY_DESTINATIONS: MilkyWayDestination[] = [
  { label: 'Nebula', pick: { r1: 0.2 } },
  { label: 'Black hole + disc', pick: { r1: 0.04, r9: 0.3 } },
  { label: 'Black hole', pick: { r1: 0.04, r9: 0.8 } },
  { label: 'Neutron star', pick: { r1: 0.1 } },
  { label: 'Through the rings', pick: { r1: 0.3, r7: 0.3, r9: 0.8, r10: 0.3 } },
  { label: 'Ringed giant', pick: { r1: 0.3, r7: 0.3, r9: 0.8, r10: 0.8 } },
  { label: 'Earth-like world', pick: { r1: 0.5, r8: 0.8, r9: 0.8 } },
  { label: 'Binary star', pick: { r1: 0.8, r9: 0.1, r12: 0.9 } },
  { label: 'Triple star', pick: { r1: 0.8, r9: 0.1, r12: 0.1 } },
  { label: 'Star', pick: { r1: 0.8, r9: 0.8 } },
]

export function jumpTo(destination: MilkyWayDestination): void {
  ;(globalThis as { beaconMilkyWayPick?: Record<string, number> }).beaconMilkyWayPick = {
    ...destination.pick,
  }
}
