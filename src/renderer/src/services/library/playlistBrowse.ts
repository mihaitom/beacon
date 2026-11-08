/** The orders and groups the desktop Playlists page offers (PlaylistsView.vue). */

import { accountScopedKey } from '@/services/accountKey'
import { isOwnedBy } from '@/services/library/playlistOwnership'
import type { Playlist } from '@/types/library'

export type PlaylistSortKey = 'changed' | 'name' | 'songCount' | 'duration'

export interface PlaylistSort {
  key: PlaylistSortKey
  direction: 'asc' | 'desc'
}

export const PLAYLIST_SORT_KEYS: PlaylistSortKey[] = ['changed', 'name', 'songCount', 'duration']

export type PlaylistSegment = 'all' | 'mine' | 'smart' | 'shared'

const STORAGE_KEY = 'beacon.playlistSort'
const DEFAULT_SORT: PlaylistSort = { key: 'changed', direction: 'desc' }

/** Names from the front; figures and dates biggest first. */
export function defaultPlaylistDirection(key: PlaylistSortKey): 'asc' | 'desc' {
  return key === 'name' ? 'asc' : 'desc'
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Null where a playlist has no usable value, which the sort puts last. */
function sortValue(playlist: Playlist, key: Exclude<PlaylistSortKey, 'name'>): number | null {
  if (key === 'songCount') return playlist.songCount
  if (key === 'duration') return playlist.duration
  const changed = playlist.changed ? Date.parse(playlist.changed) : NaN
  return Number.isNaN(changed) ? null : changed
}

export function sortPlaylists(playlists: Playlist[], sort: PlaylistSort): Playlist[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byName = (a: Playlist, b: Playlist) => collator.compare(a.name, b.name)
  return [...playlists].sort((a, b) => {
    if (sort.key === 'name') return sign * byName(a, b)
    const first = sortValue(a, sort.key)
    const second = sortValue(b, sort.key)
    if (first === null || second === null) {
      // Last whichever way round the order runs.
      if (first !== second) return first === null ? 1 : -1
      return byName(a, b)
    }
    return sign * (first - second) || byName(a, b)
  })
}

export function inSegment(playlist: Playlist, segment: PlaylistSegment, username: string): boolean {
  if (segment === 'smart') return playlist.smart
  if (segment === 'all') return true
  return isOwnedBy(playlist, username) === (segment === 'mine')
}

/** The groups worth offering for this list. Empty when there is nothing to
 * tell apart, so a server without smart or shared playlists shows no switch. */
export function availableSegments(playlists: Playlist[], username: string): PlaylistSegment[] {
  const extra = (['smart', 'shared'] as const).filter((segment) =>
    playlists.some((playlist) => inSegment(playlist, segment, username)),
  )
  return extra.length ? ['all', 'mine', ...extra] : []
}

export function loadPlaylistSort(): PlaylistSort {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(accountScopedKey(STORAGE_KEY)) ?? '',
    ) as PlaylistSort
    if (PLAYLIST_SORT_KEYS.includes(parsed.key) && ['asc', 'desc'].includes(parsed.direction)) {
      return parsed
    }
  } catch {
    // Falls through to the default.
  }
  return DEFAULT_SORT
}

export function savePlaylistSort(sort: PlaylistSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(sort))
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
