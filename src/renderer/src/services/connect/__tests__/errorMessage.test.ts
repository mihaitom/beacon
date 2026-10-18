import { describe, expect, it } from 'vitest'
import { connectErrorMessage, loginErrorMessage } from '../errorMessage'
import { ConnectApiError, ConnectUnauthorizedError, ConnectUnreachableError } from '../http'
import type { LoginFailedError } from '../types'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import italian from '@/i18n/locales/it'

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

  it('explains a cast forbidden by the server’s allow-list', () => {
    const error = new ConnectApiError('cast_forbidden', {
      error: 'cast_forbidden',
      account: 'guest',
    })

    const { message, detail } = connectErrorMessage(error)

    expect(message).not.toContain('cast_forbidden')
    expect(message).not.toContain('connect.castForbidden')
    expect(detail).toBeNull()
  })

  it('survives something that isn’t an Error at all', () => {
    expect(connectErrorMessage('plain string').message).toBe('plain string')
  })
})

function loginFailure(reason: LoginFailedError['reason'], status = 502) {
  const body = { error: 'login_failed', reason, detail: 'Media server did not respond in time' }
  return status === 401
    ? new ConnectUnauthorizedError(body.detail, body)
    : new ConnectApiError(`Connect request failed: ${body.detail}`, body)
}

describe('loginErrorMessage', () => {
  it('does not call a server that never answered a wrong password', () => {
    // The reported symptom: Navidrome busy measuring ReplayGain, the login
    // said "Media server rejected the supplied credential".
    const timeout = loginErrorMessage(loginFailure('timeout', 504))
    const rejected = loginErrorMessage(loginFailure('rejected', 401))

    expect(timeout).not.toBe(rejected)
    expect(timeout).not.toMatch(/password/i)
    expect(rejected).toMatch(/password/i)
  })

  // Every reason connect/media/login_errors.py can send. The keys are built
  // at runtime, so i18n/__tests__/keys.test.ts cannot see them.
  const reasons: LoginFailedError['reason'][] = [
    'rejected',
    'forbidden',
    'timeout',
    'unreachable',
    'dns',
    'tls',
    'invalid_url',
    'not_found',
    'unexpected_response',
    'server_unavailable',
    'server_error',
    'rate_limited',
    'incompatible',
    'auth_unsupported',
    'quick_connect_disabled',
    'unknown',
  ]

  it.each(reasons)('has a real message for reason %s, not the raw error', (reason) => {
    const message = loginErrorMessage(loginFailure(reason))
    expect(message).not.toContain('auth.loginFailed')
    expect(message).not.toContain('Connect request failed')
  })

  it.each(Object.entries({ de, en, es, fr, it: italian }))(
    'is translated for every reason in %s',
    (_, messages) => {
      const translated = messages.auth.loginFailed as Record<string, string>
      for (const key of [...reasons, 'connectUnreachable']) {
        expect(translated[key], key).toBeTruthy()
      }
    },
  )

  it('says when the connect backend itself is not answering', () => {
    const message = loginErrorMessage(
      new ConnectUnreachableError('Connect backend unreachable at /api', new TypeError()),
    )
    expect(message).not.toContain('auth.loginFailed')
    expect(message).not.toBe('Connect backend unreachable at /api')
  })

  it('passes anything unclassified through as it was', () => {
    expect(loginErrorMessage(new Error('Plex request failed'))).toBe('Plex request failed')
    expect(loginErrorMessage('plain')).toBe('plain')
  })
})
