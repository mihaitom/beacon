import { usePartyStore } from '@/stores/party'
import { usePlaybackStore } from '@/stores/playback'

/** Whether a preview would be heard by party guests listening along: they
 * read the mix of the window hosting the party, or the cast's. A preview
 * is not offered then - see docs/plans/preview-with-transitions.md. */
export function previewHeardByGuests(): boolean {
  const party = usePartyStore()
  return party.enabled && (party.hostedHere || usePlaybackStore().isCasting)
}
