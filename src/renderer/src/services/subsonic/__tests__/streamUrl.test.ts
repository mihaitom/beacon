import { describe, expect, it } from 'vitest'
import { SubsonicClient } from '../client'

/** streamUrl() becomes a raw `<audio src>` value, so everything it needs has
 * to be in the URL itself — the browser attaches no headers to a media
 * element's fetch. The two shapes it can produce go to two different
 * endpoints, and mixing them up means either no audio or no auth. */
describe('SubsonicClient.streamUrl', () => {
  const client = new SubsonicClient(
    'http://connect:8080',
    'u=bob&t=abc&s=xyz',
    'connect-token',
    'session-1',
  )

  it('points at the media server untouched by default', () => {
    const url = new URL(client.streamUrl('song-1'))

    expect(url.pathname).toBe('/rest/stream.view')
    expect(url.searchParams.get('id')).toBe('song-1')
    // Subsonic's own auth params — the media server is answering this one.
    expect(url.searchParams.get('u')).toBe('bob')
    expect(url.searchParams.get('token')).toBe('connect-token')
    expect(url.searchParams.get('session')).toBe('session-1')
  })

  it('treats an explicit "original" the same as no preference at all', () => {
    expect(client.streamUrl('song-1', { format: 'original', bitrate: 192 })).toBe(
      client.streamUrl('song-1'),
    )
  })

  it("points at connect's own transcoder for anything else", () => {
    const url = new URL(client.streamUrl('song-1', { format: 'mp3', bitrate: 192 }))

    expect(url.pathname).toBe('/stream/local/song-1')
    expect(url.searchParams.get('fmt')).toBe('mp3')
    expect(url.searchParams.get('br')).toBe('192')
  })

  it('still carries the connect token and session on the transcoded path', () => {
    // Both travel as query params for the same reason as above, and
    // require_authenticated_session 401s without the session.
    const url = new URL(client.streamUrl('song-1', { format: 'opus', bitrate: 128 }))

    expect(url.searchParams.get('token')).toBe('connect-token')
    expect(url.searchParams.get('session')).toBe('session-1')
  })

  it('does not send Subsonic credentials to the transcoder', () => {
    // connect resolves the source from the session's own media client, the
    // same way casting does — a media-server credential in this URL would
    // be a secret travelling somewhere that has no use for it.
    const url = new URL(client.streamUrl('song-1', { format: 'mp3', bitrate: 320 }))

    expect(url.searchParams.get('u')).toBeNull()
    expect(url.searchParams.get('t')).toBeNull()
    expect(url.searchParams.get('s')).toBeNull()
  })

  it('escapes a track id that is not URL-safe', () => {
    // Plex ids are paths ("/library/metadata/123"), not opaque tokens.
    const url = new URL(client.streamUrl('/library/metadata/1', { format: 'mp3', bitrate: 192 }))

    expect(url.pathname).toBe('/stream/local/%2Flibrary%2Fmetadata%2F1')
  })
})
