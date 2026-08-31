import { describe, expect, it } from 'vitest'
import { connectErrorMessage } from '../errorMessage'
import { ConnectApiError } from '../http'

function deliveryFailure(reason: string, device = 'Arbeitszimmer', detail = 'UPnP Error 800') {
  return new ConnectApiError('delivery_failed', {
    error: 'delivery_failed',
    reason,
    device,
    detail,
  })
}

describe('connectErrorMessage', () => {
  it('turns a refused stream into a sentence naming the speaker', () => {
    // The reported symptom: the cast overlay's alert said "UPnP Error 800
    // received:  from 10.2.2.112" and nothing else.
    const { message, detail } = connectErrorMessage(deliveryFailure('rejected'))

    expect(message).toContain('Arbeitszimmer')
    expect(message).not.toContain('UPnP')
    expect(message).not.toContain('800')
    // The raw text isn't thrown away, just moved out of the sentence.
    expect(detail).toBe('UPnP Error 800')
  })

  it.each(['rejected', 'busy', 'unreachable', 'station_refused', 'unknown'])(
    'has a real message for reason %s, not the key itself',
    (reason) => {
      const { message } = connectErrorMessage(deliveryFailure(reason))
      expect(message).not.toContain('connect.deliveryFailed')
      expect(message).toContain('Arbeitszimmer')
    },
  )

  it('names every speaker in a group, as the backend reported them', () => {
    const { message } = connectErrorMessage(deliveryFailure('rejected', 'room A, room B'))
    expect(message).toContain('room A, room B')
  })

  it('passes anything unclassified through as its own text', () => {
    const { message, detail } = connectErrorMessage(new Error('Connect backend unreachable'))
    expect(message).toBe('Connect backend unreachable')
    expect(detail).toBeNull()
  })

  it('passes a plain device_in_use error through untouched', () => {
    // Handled separately by the takeover flow — this must not swallow it
    // into a generic delivery message.
    const error = new ConnectApiError('device_in_use', { error: 'device_in_use' })
    expect(connectErrorMessage(error).message).toBe('device_in_use')
  })

  it('survives something that isn’t an Error at all', () => {
    expect(connectErrorMessage('plain string').message).toBe('plain string')
  })
})
