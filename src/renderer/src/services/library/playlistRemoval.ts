import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Song } from '@/types/library'

/** What a removal has to say for itself, rendered by PlaylistNotice.vue. */
export interface PlaylistNotice {
  level: 'success' | 'error'
  /** The sentence itself. */
  text: string
  /** The server's own words, where there are any worth passing on. */
  detail?: string
  /** Offered for as long as the removal can still be taken back. */
  undo?: () => void
}

export interface PlaylistRemoval {
  playlistId: string
  /** Positions within the playlist as the server holds it, not row
   * positions on screen — see SongTable.vue's onRemoveRequested(). */
  indexes: number[]
  /** The songs those positions refer to, for the toast's wording. */
  songs: Song[]
  /** The playlist's songs as they were before this removal — both the
   * source of the optimistic result and what undo sends back. */
  before: Song[]
  /** Shows a song list straight away, ahead of the server. Called again
   * after the page may already have re-read the playlist, so it has to
   * resolve the view's *current* playlist rather than one captured before
   * the call. */
  apply: (songs: Song[]) => void
  /** Puts the outcome in the page itself, or clears it again with null.
   * An offer to undo something belongs where the change it undoes is
   * visible, and has to last as long as that page does — a toast would
   * take it away again on a timer, while the reader is still looking at
   * the list it changed. */
  notify: (notice: PlaylistNotice | null) => void
  /** Re-fetches the playlist from the server. */
  reload: () => Promise<void>
}

function saidBy(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Per playlist, the last write handed out and how many callers are still
 * waiting on it. Two writes to one playlist must not overlap: a removal
 * names positions in the list as its caller last saw it, and the other
 * write is busy moving those. Nothing guarantees two requests arrive in
 * the order they were sent. */
const writes = new Map<string, { last: Promise<unknown>; waiting: number }>()

/** Runs `write` once every earlier write to the same playlist has settled,
 * and answers whether it was the last one queued. The ones that aren't
 * leave the re-read to whoever is: pulling down a list that the next write
 * is about to change again only makes the removed rows flash back. */
async function afterEarlierWrites(
  playlistId: string,
  write: () => Promise<void>,
): Promise<boolean> {
  const queue = writes.get(playlistId) ?? { last: Promise.resolve(), waiting: 0 }
  queue.waiting++
  writes.set(playlistId, queue)
  // Either way round: an earlier write failing is no reason to skip this
  // one, only to stop waiting for it.
  const running = queue.last.then(write, write)
  queue.last = running.catch(() => undefined)
  try {
    await running
  } finally {
    queue.waiting--
    if (!queue.waiting) writes.delete(playlistId)
  }
  return queue.waiting === 0
}

/** Reads the playlist back once the write has landed.
 *
 * The optimistic list is what was *asked for*, which is not the same as
 * what happened: both bridges drop a position the playlist no longer has
 * without saying so, and Jellyfin 12 takes every copy of a song listed
 * twice rather than the one that was named (see
 * docs/investigations/playlist-duplicate-entries.md). Re-reading is also
 * what puts the header's track count and running time right. */
async function reconcile(wasLastWrite: boolean, reload: () => Promise<void>): Promise<void> {
  if (wasLastWrite) await reload()
}

/** Removes songs from a playlist, showing the result straight away and
 * offering to undo it.
 *
 * Shared by the desktop and phone playlist pages, which otherwise keep
 * their own copies of the view logic — this one is worth having in a
 * single place because getting the failure path wrong loses tracks.
 *
 * On failure it re-fetches rather than putting `before` back the way
 * PlaylistDetailView's onReorder() does. A reorder is one request that
 * either lands or doesn't, but removing several entries is not: the Plex
 * bridge has no bulk delete and issues one DELETE per entry (see
 * plex_bridge.py's _remove_from_playlist), so a failure halfway through
 * means some really are gone. Restoring the full list locally would then
 * show tracks the server no longer has.
 */
export async function removeFromPlaylist(removal: PlaylistRemoval): Promise<void> {
  const { playlistId, indexes, songs, before, apply, notify, reload } = removal
  const t = i18n.global.t
  const library = useLibraryStore()

  // By position, not by identity: `songs` reaches this through a prop and
  // is the reactive proxy of what the view holds in some callers and the
  // raw object in others, so an identity check silently matches nothing.
  // The positions are what the server is told anyway, so filtering by them
  // is also the only way the local list can't disagree with the result.
  const dropped = new Set(indexes)
  apply(before.filter((_song, position) => !dropped.has(position)))

  let wasLastWrite: boolean
  try {
    wasLastWrite = await afterEarlierWrites(playlistId, () =>
      library.removeFromPlaylist(playlistId, indexes),
    )
  } catch (error) {
    await reload()
    notify({ level: 'error', text: t('playlists.removeFailed'), detail: saidBy(error) })
    console.error('[playlist] Failed to remove songs from playlist:', error)
    return
  }

  await reconcile(wasLastWrite, reload)

  notify({
    level: 'success',
    text:
      songs.length === 1
        ? t('playlists.removedOne', { title: songs[0]!.title })
        : t('playlists.removedMany', { count: songs.length }),
    undo: () => void undoRemoval(removal),
  })
}

/** Puts the playlist back the way it was before a removal. Same reasoning
 * as the failure path above for re-fetching instead of trusting the local
 * copy: the bridges rebuild the list entry by entry and can stop partway
 * (see their _set_playlist_songs), and on Plex a second copy of a song
 * cannot come back at all. */
async function undoRemoval({
  playlistId,
  before,
  apply,
  notify,
  reload,
}: PlaylistRemoval): Promise<void> {
  const t = i18n.global.t
  const library = useLibraryStore()

  apply([...before])
  // The offer is spent the moment it is taken — pressing undo twice would
  // send the same list a second time.
  notify(null)

  let wasLastWrite: boolean
  try {
    wasLastWrite = await afterEarlierWrites(playlistId, () =>
      library.restorePlaylistSongs(
        playlistId,
        before.map((song) => song.id),
      ),
    )
  } catch (error) {
    await reload()
    notify({ level: 'error', text: t('playlists.restoreFailed'), detail: saidBy(error) })
    console.error('[playlist] Failed to restore playlist after an undo:', error)
    return
  }

  await reconcile(wasLastWrite, reload)
}
