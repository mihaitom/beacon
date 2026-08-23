import { describe, expect, it } from 'vitest'
import { computeConnectSessionId, normalizeServerUrl } from '../session-id'

const base = { serverType: 'subsonic', userId: '', username: 'alice' }

describe('normalizeServerUrl', () => {
  it('reduces the address to the server it identifies', () => {
    expect(normalizeServerUrl('https://Media.Example/')).toBe('media.example')
    expect(normalizeServerUrl('http://media.example')).toBe('media.example')
    expect(normalizeServerUrl('  https://media.example:443//  ')).toBe('media.example')
    expect(normalizeServerUrl('http://media.example:80')).toBe('media.example')
  })

  it('keeps a sub-path, which really is a different server', () => {
    expect(normalizeServerUrl('https://media.example/music')).toBe('media.example/music')
  })

  it('keeps a non-default port', () => {
    expect(normalizeServerUrl('http://media.example:4533')).toBe('media.example:4533')
  })
})

describe('computeConnectSessionId', () => {
  it('gives the same session to the same login however the URL was typed', () => {
    /** The bug this exists for: a server behind a reverse proxy answers
     * http:// with a redirect to https://, so a login typed without the "s"
     * verifies and streams perfectly - while hashing to a different session.
     * Observed 2026-08-23: a phone logged in that way saw no playback at all
     * and could have taken the speaker away from the desktop that was
     * casting. */
    const canonical = computeConnectSessionId({ ...base, url: 'https://media.example' })

    expect(computeConnectSessionId({ ...base, url: 'http://media.example' })).toBe(canonical)
    expect(computeConnectSessionId({ ...base, url: 'https://media.example/' })).toBe(canonical)
    expect(computeConnectSessionId({ ...base, url: 'https://MEDIA.example' })).toBe(canonical)
  })

  it('still separates different users, servers and server types', () => {
    const a = computeConnectSessionId({ ...base, url: 'https://media.example' })

    expect(computeConnectSessionId({ ...base, url: 'https://other.example' })).not.toBe(a)
    expect(
      computeConnectSessionId({ ...base, username: 'bob', url: 'https://media.example' }),
    ).not.toBe(a)
    expect(
      computeConnectSessionId({ ...base, serverType: 'jellyfin', url: 'https://media.example' }),
    ).not.toBe(a)
  })

  it('prefers a stable user id over a display name when there is one', () => {
    const withId = { ...base, userId: 'u-1', url: 'https://media.example' }

    expect(computeConnectSessionId(withId)).toBe(
      computeConnectSessionId({ ...withId, username: 'renamed' }),
    )
  })
})
