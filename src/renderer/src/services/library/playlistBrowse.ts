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

export type PlaylistSegment = 'all' | 'mine' | 'smart' | 'sharedByMe' | 'sharedWithMe'

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
  const owned = isOwnedBy(playlist, username)
  if (segment === 'sharedByMe') return owned && playlist.public
  return owned === (segment === 'mine')
}

/** The groups worth offering for this list. Empty when there is nothing to
 * tell apart, so a server without smart or shared playlists shows no switch. */
export function availableSegments(playlists: Playlist[], username: string): PlaylistSegment[] {
  const extra = (['smart', 'sharedByMe', 'sharedWithMe'] as const).filter((segment) =>
    playlists.some((playlist) => inSegment(playlist, segment, username)),
  )
  return extra.length ? ['all', 'mine', ...extra] : []
}

export interface PlaylistSections {
  /** The user's own that nobody else sees. */
  mine: Playlist[]
  sharedByMe: Playlist[]
  sharedWithMe: Playlist[]
}

/** The sections a page lists playlists under, each playlist in exactly one. */
export function sectionPlaylists(playlists: Playlist[], username: string): PlaylistSections {
  const sharedByMe = (playlist: Playlist) => inSegment(playlist, 'sharedByMe', username)
  const mine = (playlist: Playlist) => inSegment(playlist, 'mine', username)
  return {
    mine: playlists.filter((playlist) => mine(playlist) && !sharedByMe(playlist)),
    sharedByMe: playlists.filter(sharedByMe),
    sharedWithMe: playlists.filter((playlist) => !mine(playlist)),
  }
}

export interface PlaylistSection {
  key: keyof PlaylistSections
  title: string
  playlists: Playlist[]
}

/** The sections that have anything in them, titled, in page order. */
export function playlistSectionsFor(
  playlists: Playlist[],
  username: string,
  t: (key: string) => string,
): PlaylistSection[] {
  const sections = sectionPlaylists(playlists, username)
  const titles = {
    mine: 'playlists.personal',
    sharedByMe: 'playlists.sharedByMe',
    sharedWithMe: 'playlists.sharedWithMe',
  } as const
  return (Object.keys(titles) as (keyof PlaylistSections)[])
    .filter((key) => sections[key].length)
    .map((key) => ({ key, title: t(titles[key]), playlists: sections[key] }))
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
