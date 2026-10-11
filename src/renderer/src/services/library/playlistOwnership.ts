import type { Playlist } from '@/types/library'

/** Whether a playlist is the signed-in user's own, to rename, delete and
 * list under "My playlists". The Jellyfin and Plex bridges say so outright,
 * since neither server names an owner Beacon could compare; a Subsonic
 * server only names one. */
export function isOwnedBy(playlist: Playlist, username: string): boolean {
  return playlist.ownedByUser ?? playlist.owner === username
}
