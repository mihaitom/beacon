import { PartyApiError } from './api'

/** The partyGuest.* message for a failed guest action. Refusals the host's
 * app gives on purpose (routes/party.py's _REFUSALS) arrive as their bare
 * code. */
export function guestErrorKey(error: unknown): string {
  if (!(error instanceof PartyApiError)) return 'partyGuest.errGeneric'
  if (error.status === 0 || error.status === 503 || error.status === 504) {
    return 'partyGuest.errOffline'
  }
  if (error.status === 429) return 'partyGuest.errRate'
  if (error.message === 'limit') return 'partyGuest.errLimit'
  if (error.message === 'duplicate') return 'partyGuest.errDuplicate'
  if (error.message === 'not-found') return 'partyGuest.errNotFound'
  if (error.message === 'radio') return 'partyGuest.radioText'
  return 'partyGuest.errGeneric'
}
