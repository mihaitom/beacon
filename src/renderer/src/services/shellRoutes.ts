import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router'

/** Where a page lives in the other shell, for when the layout switches
 * under it - a browser window resized across the breakpoint, or a tablet
 * turned (an iPad is the phone shell upright and the desktop one on its
 * side). Without this the route stayed put, and the phone's Now Playing,
 * which brings its own transport controls, sat in the desktop shell above
 * the desktop's player bar: two of them.
 *
 * `queueDrawer` is set for the phone's Queue tab, which has no page of its
 * own on the desktop - the queue is a drawer there.
 *
 * Null for a page that stays where it is: one already in the right shell,
 * and the desktop pages with no phone design (artists, genres, search,
 * stats, settings), which the phone shell shows as they are. */
export function routeInOtherShell(
  route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params' | 'query'>,
  mobile: boolean,
): { to: RouteLocationRaw; queueDrawer?: boolean } | null {
  const id = route.params.id
  if (mobile) {
    switch (route.name) {
      case 'home':
      case 'now-playing':
        return { to: { name: 'm-now-playing' } }
      case 'playlists':
        return { to: { name: 'm-playlists' } }
      case 'playlist-detail':
        return { to: { name: 'm-playlist-detail', params: { id } } }
      case 'songs':
        return { to: { name: 'm-library' } }
      case 'albums':
        return { to: { name: 'm-library', query: { tab: 'albums' } } }
      case 'album-detail':
        return { to: { name: 'm-album-detail', params: { id } } }
      case 'radio':
        return { to: { name: 'm-radio' } }
      default:
        return null
    }
  }
  switch (route.name) {
    case 'm-now-playing':
      return { to: { name: 'now-playing' } }
    case 'm-queue':
      return { to: { name: 'now-playing' }, queueDrawer: true }
    case 'm-playlists':
      return { to: { name: 'playlists' } }
    case 'm-playlist-detail':
      return { to: { name: 'playlist-detail', params: { id } } }
    case 'm-library':
      return { to: { name: route.query.tab === 'albums' ? 'albums' : 'songs' } }
    case 'm-album-detail':
      return { to: { name: 'album-detail', params: { id } } }
    case 'm-radio':
      return { to: { name: 'radio' } }
    default:
      return null
  }
}
