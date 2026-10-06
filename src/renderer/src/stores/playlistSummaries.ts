import { defineStore } from 'pinia'
import { useLibraryStore } from '@/stores/library'
import {
  summarizePlaylist,
  summaryKey,
  type PlaylistSummary,
} from '@/services/library/playlistSummary'
import type { Playlist } from '@/types/library'

// The overview's list carries no songs, so every summary is one
// getPlaylist call with the whole track list. Visible cards ask for theirs
// at once on opening the page; this keeps that from becoming one burst of
// full playlists against the media server.
export const MAX_CONCURRENT_FETCHES = 3

interface Entry {
  /** The playlist version this entry was fetched for. */
  key: string
  /** Null if that fetch failed: a card falls back to the server's own
   * artwork rather than retrying on every render. */
  summary: PlaylistSummary | null
}

let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_FETCHES) await new Promise<void>((go) => waiting.push(go))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

export const usePlaylistSummariesStore = defineStore('playlistSummaries', {
  state: () => ({
    entries: {} as Record<string, Entry>,
  }),
  actions: {
    /** The latest summary known, even one for an older version of the
     * playlist - it stays up while the new one loads. */
    summaryFor(playlist: Playlist): PlaylistSummary | null {
      return this.entries[playlist.id]?.summary ?? null
    },

    /** True once a fetch for this version of the playlist has finished,
     * whether or not it produced a summary. */
    isSettled(playlist: Playlist): boolean {
      return this.entries[playlist.id]?.key === summaryKey(playlist)
    },

    /** Fetches the playlist's summary unless this version of it is already
     * known or on its way. An edited playlist has a new key and is fetched
     * again; the old summary stays up until the new one is in. */
    async ensure(playlist: Playlist): Promise<void> {
      const key = summaryKey(playlist)
      if (this.entries[playlist.id]?.key === key) return
      const id = pendingId(playlist)
      if (pending.has(id)) return
      pending.add(id)
      const startedIn = generation
      try {
        const full = await withSlot(() => useLibraryStore().client().getPlaylist(playlist.id))
        if (startedIn !== generation) return
        this.entries[playlist.id] = { key, summary: summarizePlaylist(full.songs) }
      } catch (error) {
        console.warn('[playlists] Could not summarise playlist', playlist.id, error)
        if (startedIn !== generation) return
        this.entries[playlist.id] = { key, summary: this.entries[playlist.id]?.summary ?? null }
      } finally {
        pending.delete(id)
      }
    },

    /** Playlist ids are only unique within one media server. */
    reset(): void {
      generation++
      pending.clear()
      this.entries = {}
    },
  },
})

// Outside the state: nothing renders from it, it only stops a second card
// for the same playlist (the spotlight and its grid card) fetching twice.
const pending = new Set<string>()
// Bumped by reset(), so a fetch still running for the previous account
// cannot write its answer into the next one's entries.
let generation = 0

function pendingId(playlist: Playlist): string {
  return `${playlist.id}|${summaryKey(playlist)}`
}
