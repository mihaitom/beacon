import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import router from '@/router'
import { routeInOtherShell } from '../shellRoutes'

type Route = Parameters<typeof routeInOtherShell>[0]

function route(name: string, params: Record<string, string> = {}, query = {}): Route {
  return { name, params, query }
}

/** The name and params of where `from` goes, resolved against the real
 * router - a target naming a route that doesn't exist throws here. */
function landing(from: Route, mobile: boolean) {
  const target = routeInOtherShell(from, mobile)
  if (!target) return null
  const resolved = router.resolve(target.to)
  return {
    name: resolved.name,
    params: resolved.params,
    query: resolved.query,
    queueDrawer: target.queueDrawer ?? false,
  }
}

/** A tablet turned, or a window resized across the breakpoint, swaps the
 * shell under the current page. Reported 2026-10-11 from an iPad: turning
 * it on Now Playing left the phone's page, transport controls and all, in
 * the desktop shell above the desktop's own player bar. */
describe('routeInOtherShell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('into the desktop shell', () => {
    it.each([
      ['m-now-playing', 'now-playing'],
      ['m-playlists', 'playlists'],
      ['m-radio', 'radio'],
      ['m-library', 'songs'],
    ])('takes %s to %s', (from, to) => {
      expect(landing(route(from), false)?.name).toBe(to)
    })

    it('keeps the playlist and the album that were open', () => {
      expect(landing(route('m-playlist-detail', { id: 'p1' }), false)).toMatchObject({
        name: 'playlist-detail',
        params: { id: 'p1' },
      })
      expect(landing(route('m-album-detail', { id: 'a1' }), false)).toMatchObject({
        name: 'album-detail',
        params: { id: 'a1' },
      })
    })

    it('takes the library to albums when that is the half showing', () => {
      expect(landing(route('m-library', {}, { tab: 'albums' }), false)?.name).toBe('albums')
    })

    /** The desktop has no queue page; the queue is the drawer beside Now
     * Playing. */
    it('takes the queue to Now Playing with the queue drawer open', () => {
      expect(landing(route('m-queue'), false)).toMatchObject({
        name: 'now-playing',
        queueDrawer: true,
      })
    })

    it('leaves a desktop page alone', () => {
      expect(routeInOtherShell(route('now-playing'), false)).toBeNull()
      expect(routeInOtherShell(route('artist-detail', { id: 'x' }), false)).toBeNull()
    })
  })

  describe('into the phone shell', () => {
    it.each([
      ['home', 'm-now-playing'],
      ['now-playing', 'm-now-playing'],
      ['playlists', 'm-playlists'],
      ['radio', 'm-radio'],
      ['songs', 'm-library'],
    ])('takes %s to %s', (from, to) => {
      expect(landing(route(from), true)?.name).toBe(to)
    })

    it('keeps the playlist and the album that were open', () => {
      expect(landing(route('playlist-detail', { id: 'p1' }), true)).toMatchObject({
        name: 'm-playlist-detail',
        params: { id: 'p1' },
      })
      expect(landing(route('album-detail', { id: 'a1' }), true)).toMatchObject({
        name: 'm-album-detail',
        params: { id: 'a1' },
      })
    })

    it('opens the library on its albums half for the album grid', () => {
      expect(landing(route('albums'), true)).toMatchObject({
        name: 'm-library',
        query: { tab: 'albums' },
      })
    })

    /** No phone design for these; the phone shell shows them as they are,
     * the way it does when Now Playing links to an artist. */
    it.each(['artists', 'artist-detail', 'genres', 'search', 'stats', 'settings', 'favorites'])(
      'leaves %s where it is',
      (name) => {
        expect(routeInOtherShell(route(name), true)).toBeNull()
      },
    )

    it('leaves a phone page alone', () => {
      expect(routeInOtherShell(route('m-queue'), true)).toBeNull()
    })
  })

  /** Turning a tablet back and forth must end up where it started. */
  it.each([
    route('m-now-playing'),
    route('m-playlists'),
    route('m-playlist-detail', { id: 'p1' }),
    route('m-library'),
    route('m-library', {}, { tab: 'albums' }),
    route('m-album-detail', { id: 'a1' }),
    route('m-radio'),
  ])('round-trips $name', (start) => {
    const there = landing(start, false)!
    const back = landing(route(String(there.name), there.params as never, there.query), true)!
    expect(back.name).toBe(start.name)
    expect(back.params).toEqual(start.params)
    expect(back.query).toEqual(start.query)
  })
})
