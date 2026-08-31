import { i18n } from '@/i18n'
import { ConnectApiError } from './http'
import { isDeliveryFailedError } from './types'

/** What a failed cast should actually say to the person who tried it, and
 * the technical line that belongs under it.
 *
 * Everything the connect backend refuses used to reach the cast overlay's
 * alert as whatever text the underlying library happened to raise. `UPnP
 * Error 800 received:  from 10.2.2.112` is a real example: it names no
 * device the listener recognises, no action they could take, and not even
 * which of the two things they just did produced it.
 *
 * A classified failure (see connect/delivery/errors.py) becomes a real
 * sentence naming the speaker, with the raw text kept as `detail` rather
 * than dropped — a listener needs to know their speaker refused the
 * station, and whoever they ask about it needs to know it said 800.
 * Anything else is passed through as before, which is still the best
 * available text for it. */
export function connectErrorMessage(error: unknown): { message: string; detail: string | null } {
  if (error instanceof ConnectApiError && isDeliveryFailedError(error.body)) {
    const { reason, device, detail } = error.body
    return {
      message: i18n.global.t(`connect.deliveryFailed.${reason}`, { device }),
      detail,
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    detail: null,
  }
}
