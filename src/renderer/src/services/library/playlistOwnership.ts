import type { ServerCapabilities } from '@/services/capabilities'
import type { Playlist } from '@/types/library'

/** Whether a playlist is the signed-in user's own, to rename, delete and
 * list under "My playlists". The Jellyfin and Plex bridges say so outright,
 * since neither server names an owner Beacon could compare; a Subsonic
 * server only names one. */
export function isOwnedBy(playlist: Playlist, username: string): boolean {
  return playlist.ownedByUser ?? playlist.owner === username
}

/** Whether this account may rename and delete a playlist: its owner, or a
 * Navidrome admin, whom the server lets change anyone's. */
export function canManagePlaylist(
  playlist: Playlist,
  username: string,
  capabilities: Pick<ServerCapabilities, 'playlistAdmin'>,
): boolean {
  return capabilities.playlistAdmin || isOwnedBy(playlist, username)
}
