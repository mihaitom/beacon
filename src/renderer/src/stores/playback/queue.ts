/** The queue: what plays next, its order, and Autoplay's additions. */
import { useLibraryStore } from '../library'
import { useAuthStore } from '../auth'
import { AUTOPLAY_BATCH_SIZE, autoplayCandidateCount, useAutoplayStore } from '../autoplay'
import { useDrawersStore } from '../drawers'
import type { Song } from '@/types/library'
import { shuffled } from '@/services/shuffle'
import { createLock } from '@/services/playback/lock'
import { dedupeForQueue, keptAfter, shuffledExcept } from '@/services/playback/queueOps'
import type { RepeatMode } from '@/services/playback/types'
import { notifyPlexPassRequired, autoplayExhaustedSeedIds } from './shared'
import type { PlaybackContext } from './context'
import type { QueueMoveTarget } from './state'

// maybeAutoplay() tops the queue back up once at most this many songs are
// left after the current one — 1, not 0, so there's a whole song's worth of
// lead time for the getSimilarSongs2() round trip to finish before the
// queue would otherwise actually run dry.
const AUTOPLAY_TRIGGER_REMAINING = 1

// How many songs back from the end Autoplay will look for a seed that
// actually has similar songs. Three because the dead ends measured against
// a real Jellyfin library are scattered (~3% of tracks), not clustered —
// two neighbours are enough to get past one, and every extra attempt is
// another request on a queue that may simply have run out of pool.
const AUTOPLAY_SEED_ATTEMPTS = 3

/** Autoplay's last resort, once every seed it could try came back with
 * nothing. Answered from the catalog already in memory rather than another
 * request: the server has just said it knows nothing similar, and asking it
 * something else would only be a different way of getting the same silence.
 *
 * More of what was playing before anything else — a server with no
 * similarity data at all (Jellyfin without genre tags, say) would otherwise
 * turn the end of every queue into a jump from metal to classical. Only
 * where that artist is exhausted too does this reach for the whole library,
 * which is still better than the queue simply stopping. */
function localFollowUp(queue: Song[], seed: Song | undefined, count: number): Song[] {
  const library = useLibraryStore()
  if (!library.allSongsLoaded) return [] // nothing browsed yet, nothing to pick from
  const queued = new Set(queue.map((song) => song.id))
  const pool = library.allSongs.filter((song) => !queued.has(song.id))
  const sameArtist = seed ? pool.filter((song) => song.artist === seed.artist) : []
  return shuffled(sameArtist.length ? sameArtist : pool).slice(0, count)
}

// Guards maybeAutoplay() against firing a second, overlapping fetch —
// startCurrent() and adoptCastQueue() both call it on every song change,
// which for a cast session receiving ~2s SSE ticks can mean several calls
// landing before the first getSimilarSongs2() round trip even returns.
// Module-level, not per-invocation, for the same reason as cast.ts's
// queueReconcileGuard: it needs to survive across those calls.
const autoplayLock = createLock()

export interface QueueActions {
  setQueue(songs: Song[], startIndex?: number, pinFirst?: boolean): void
  nextIndex(delta: 1 | -1): number | null
  replaceQueueAfterCurrent(songs: Song[]): void
  toggleShuffle(): void
  cycleRepeatMode(): void
  addToQueue(songs: Song[], options?: { autoplayTopUp?: boolean }): void
  maybeAutoplay(): Promise<void>
  queueNext(songs: Song[]): void
  insertAt(index: number, songs: Song[]): Song[]
  removeFromQueue(index: number): void
  reorderQueue(from: number, to: number): void
  moveInQueue(from: number, where: QueueMoveTarget): boolean
  sortQueueByBpm(): void
  clearQueue(): void
}

export const queueActions: QueueActions & ThisType<PlaybackContext> = {
  /** Sets up queue + currentIndex only — no playback side effect.
   *
   * `pinFirst`: whether `songs[startIndex]` was something the user
   * actually picked (a specific row clicked in a list) as opposed to just
   * where a generic "Play"/"Play random" action happens to start counting
   * from (always 0, no real selection behind it). True keeps that song
   * first even under shuffle — "you picked this one, shuffle only decides
   * what comes after" (also what Song/Artist Radio wants, see
   * startSongRadio()). False lets shuffle include the very first song
   * too — without this, hitting "Play" on a shuffled playlist/album
   * always started on track 1 in its original, unshuffled position,
   * shuffle only kicking in from the second song onward. */
  setQueue(songs: Song[], startIndex = 0, pinFirst = true): void {
    this.leaveRadio()
    // A different queue is a different question, even where its last song
    // happens to be one Autoplay gave up on before.
    autoplayExhaustedSeedIds.clear()
    this.originalQueue = [...songs]
    // Unshuffled, this.queue is `songs` in the same order, so startIndex
    // already *is* the right index — re-deriving it by id below would
    // resolve to the first occurrence of that id instead, playing the
    // wrong position whenever the same song appears twice in the list
    // (e.g. a playlist with a duplicate, or two concatenated playlists).
    // Shuffled, shuffledExcept() always places the kept song at index 0,
    // so the id lookup there can only ever match that same instance.
    if (this.shuffle) {
      const keep = pinFirst ? songs[startIndex] : null
      this.queue = shuffledExcept(songs, keep)
      this.currentIndex = keep ? this.queue.findIndex((t) => t.id === keep.id) : 0
    } else {
      this.queue = [...songs]
      this.currentIndex = startIndex
    }
  },

  /** Index math only (repeat-mode aware), no state mutation — returns the
   * index playNext()/playPrevious() should switch to, or null if there's
   * nowhere to go. Deliberately doesn't touch currentIndex itself: it used
   * to, but that let the UI (queue highlight, PlayerBar) jump to the next
   * song before the connect dispatch that's supposed to actually start it
   * had even resolved. If that dispatch then failed (device briefly
   * unreachable, claim race, ...), nothing rolled the index back — Beacon
   * kept showing "now playing" whatever song it had optimistically
   * advanced to, while the connect target was still audibly on the
   * previous one. See switchToIndex(), which now owns committing the
   * index change only once startCurrent() actually succeeds. */
  nextIndex(delta: 1 | -1): number | null {
    if (delta === 1) {
      if (this.currentIndex < this.queue.length - 1) return this.currentIndex + 1
      if (this.repeatMode === 'all' && this.queue.length > 0) return 0
      return null
    }
    if (this.currentIndex > 0) return this.currentIndex - 1
    if (this.repeatMode === 'all' && this.queue.length > 0) return this.queue.length - 1
    return null
  },

  /** Swaps everything around the current song for `songs`, without
   * touching what is playing. A locked next song stays next (see
   * lockedNextIndex), the way clearQueue() keeps it. */
  replaceQueueAfterCurrent(songs: Song[]): void {
    const current = this.queue[this.currentIndex]
    if (!current) return
    const lockedNext = this.queue[this.lockedNextIndex]
    const head = lockedNext ? [current, lockedNext] : [current]
    const rest = songs.filter((t) => t.id !== lockedNext?.id)
    autoplayExhaustedSeedIds.clear()
    this.originalQueue = [...head, ...rest]
    this.queue = [...head, ...(this.shuffle ? shuffledExcept(rest, null) : rest)]
    this.currentIndex = 0
    this.syncCastQueue()
    useDrawersStore().peekQueueDrawer(this.queue)
  },

  toggleShuffle(): void {
    this.shuffle = !this.shuffle
    // queuedSong, not currentSong: this re-pins the queue around
    // wherever it stands, which is still a real position while a radio
    // station is playing over the top of it (see currentSong's own
    // docstring). Reading null there would reshuffle the queue and leave
    // currentIndex pointing at whatever landed in that slot.
    const current = this.queuedSong
    const lockedNext = this.queue[this.lockedNextIndex]
    this.queue = this.shuffle
      ? shuffledExcept(this.originalQueue, current)
      : [...this.originalQueue]
    if (current) {
      this.currentIndex = this.queue.findIndex((t) => t.id === current.id)
    }
    if (lockedNext) {
      // keptAfter() can move the current song too (a locked one that sat
      // before it), so its index is looked up again.
      const playing = this.queue[this.currentIndex]
      this.queue = keptAfter(this.queue, this.currentIndex, lockedNext)
      if (playing) this.currentIndex = this.queue.indexOf(playing)
    }
    this.syncCastQueue()
  },

  cycleRepeatMode(): void {
    const order: RepeatMode[] = ['off', 'all', 'one']
    this.repeatMode = order[(order.indexOf(this.repeatMode) + 1) % order.length]!
    // castQueuePayload truncates to history+current under repeat-one (see
    // its own comment) — switching into or out of that mode changes what
    // connect should be auto-advancing through even though this.queue
    // itself didn't change.
    this.syncCastQueue()
  },

  // The one central "something just landed in the queue that the user
  // didn't necessarily see coming" spot — covers every caller (a song's
  // own context menu, the mobile action sheet, remote-control commands
  // from a phone, and maybeAutoplay()'s own top-up below) with a single
  // peekQueueDrawer() rather than needing one at each call site.
  addToQueue(songs: Song[], { autoplayTopUp = false } = {}): void {
    const toAdd = dedupeForQueue(songs, this.queue)
    this.originalQueue.push(...toAdd)
    this.queue.push(...toAdd)
    this.syncCastQueue({ autoplayTopUp })
    useDrawersStore().peekQueueDrawer(toAdd)
  },

  /** Autoplay — called after every song change (startCurrent(),
   * adoptCastQueue()) to top the queue back up with similar songs once
   * it's about to run out, the same getSimilarSongs2() endpoint Song/
   * Artist Radio use (see startSongRadio()/startArtistRadio()), seeded
   * from the last song already queued rather than the one currently
   * playing — continues whatever's already lined up next instead of
   * jumping back to the vibe of a song several tracks ago. A no-op
   * (returns immediately) unless the setting's on, the server can
   * actually do it, there's no repeat mode already keeping the queue
   * from ever running out, and there's little enough left to actually
   * be worth topping up — see the guards below and
   * AUTOPLAY_TRIGGER_REMAINING's own comment. */
  async maybeAutoplay(): Promise<void> {
    if (this.radioStation) return // no queue concept to extend
    if (this.repeatMode !== 'off') return // never runs out on its own
    const autoplay = useAutoplayStore()
    if (!autoplay.enabled) return
    if (!useAuthStore().capabilities.songRadio) return
    if (this.currentIndex < 0) return
    if (this.queue.length - 1 - this.currentIndex > AUTOPLAY_TRIGGER_REMAINING) return
    if (autoplayLock.isLocked()) return // already topping up from an earlier call

    // The queue's last song is the seed, but not the only candidate: some
    // tracks come back with nothing at all (Jellyfin's InstantMix answers
    // ~3% of a real library with just the seed itself, mostly where the
    // genre tag is one semicolon-joined string it shares with nobody).
    // The last song stops changing once nothing is appended, so a single
    // dead seed used to end Autoplay for the rest of the queue — walking
    // back a few songs finds one that still has neighbours.
    // A fixed window of the last few songs, not "the last few that are not
    // written off yet": once those are all exhausted this has to go quiet
    // until the queue actually changes, rather than walking further back
    // on every status tick and asking again for the whole queue.
    const seeds: Song[] = []
    for (
      let i = this.queue.length - 1;
      i >= 0 && this.queue.length - i <= AUTOPLAY_SEED_ATTEMPTS;
      i--
    ) {
      const candidate = this.queue[i]
      if (candidate && !autoplayExhaustedSeedIds.has(candidate.id)) seeds.push(candidate)
    }
    if (!seeds.length) return
    autoplayLock.acquire()
    try {
      for (const seed of seeds) {
        const { songs: similar, plexPassRequired } = await useLibraryStore()
          .client()
          .getSimilarSongs2(seed.id, autoplayCandidateCount(this.queue.length))
        if (plexPassRequired) {
          // Unlike Song/Artist Radio's own one-shot notify-and-move-on
          // (startSongRadio()/startArtistRadio()), Autoplay is a standing
          // setting — leaving it on would just mean the exact same 403
          // again at the next song change, and the one right after that,
          // for as long as playback continues. Switching it back off is
          // what actually stops the repeat performance; the toast is what
          // explains why it turned itself off rather than that just being
          // silently confusing. Returns rather than trying the next seed:
          // the Plex Pass is missing for every one of them alike.
          this.setAutoplayEnabled(false)
          notifyPlexPassRequired('player.autoplay')
          return
        }
        // Filtered by id, not just dedupeForQueue()'s object-identity
        // dedup below (which only stops the *same* Song object landing in
        // the queue twice, not a genuine repeat) — otherwise a small
        // library's similar-songs pool keeps circling back to whatever's
        // already just been played, and autoplay would spend its fetches
        // re-adding songs still sitting right there in the queue instead
        // of actually extending it. The batch size is applied after the
        // filter, on what is actually new — the request over-fetched for
        // exactly this, see autoplayCandidateCount().
        const existingIds = new Set(this.queue.map((t) => t.id))
        const fresh = similar.filter((t) => !existingIds.has(t.id)).slice(0, AUTOPLAY_BATCH_SIZE)
        if (fresh.length) {
          this.addToQueue(fresh, { autoplayTopUp: true })
          return
        }
        // Only on a successful round trip: a lookup that threw (below) is
        // a failure to ask, not an answer, and must stay retryable. Kept
        // rather than cleared on the next success — a seed that has no
        // neighbours will not grow any, and the queue this is filtered
        // against only ever gets longer.
        autoplayExhaustedSeedIds.add(seed.id)
      }
      // Every seed drew a blank — carry on from the local catalog rather
      // than letting the queue run out (see localFollowUp).
      const local = localFollowUp(this.queue, seeds[0], AUTOPLAY_BATCH_SIZE)
      if (local.length) this.addToQueue(local, { autoplayTopUp: true })
    } catch (error) {
      console.error('[playback] Autoplay top-up failed:', error)
    } finally {
      autoplayLock.release()
    }
  },

  /** Inserts `songs` right after the currently playing one — "Play next",
   * as opposed to addToQueue() which appends at the end. */
  queueNext(songs: Song[]): void {
    if (this.currentIndex < 0) {
      this.addToQueue(songs) // peeks on its own, see its own comment
      return
    }
    this.insertAt(this.currentIndex + 1, songs)
  },

  /** Inserts `songs` at queue position `index` (after the current song at
   * the earliest, after a locked next one - see lockedNextIndex). In the unshuffled order they follow whatever precedes
   * them here, so turning shuffle off keeps them where they were put.
   * Returns what actually went in - dedupeForQueue() may hand back
   * copies. */
  insertAt(index: number, songs: Song[]): Song[] {
    const at = Math.min(
      Math.max(index, this.currentIndex + 1, this.lockedNextIndex + 1, 0),
      this.queue.length,
    )
    const toInsert = dedupeForQueue(songs, this.queue)
    // Read before the splice: the song the new ones follow.
    const before = at > 0 ? this.queue[at - 1] : undefined
    this.queue.splice(at, 0, ...toInsert)
    const originalIndex = before ? this.originalQueue.findIndex((t) => t.id === before.id) : -1
    if (originalIndex >= 0) {
      this.originalQueue.splice(originalIndex + 1, 0, ...toInsert)
    } else {
      this.originalQueue.push(...toInsert)
    }
    this.syncCastQueue()
    useDrawersStore().peekQueueDrawer(toInsert)
    return toInsert
  },

  removeFromQueue(index: number): void {
    if (index === this.currentIndex) return // can't remove what's playing
    if (index === this.lockedNextIndex) return
    const [removed] = this.queue.splice(index, 1)
    if (index < this.currentIndex) this.currentIndex -= 1
    if (removed) {
      const originalIndex = this.originalQueue.findIndex((t) => t.id === removed.id)
      if (originalIndex >= 0) this.originalQueue.splice(originalIndex, 1)
    }
    this.syncCastQueue()
  },

  /** Refused when it would take a locked next song (see
   * lockedNextIndex) away from right after the current one. */
  reorderQueue(from: number, to: number): void {
    const lockedNext = this.queue[this.lockedNextIndex]
    const queue = [...this.queue]
    const [moved] = queue.splice(from, 1)
    if (!moved) return
    queue.splice(to, 0, moved)
    let current = this.currentIndex
    if (from === current) current = to
    else if (from < current && to >= current) current -= 1
    else if (from > current && to <= current) current += 1
    if (lockedNext && queue[current + 1] !== lockedNext) return
    this.queue = queue
    this.currentIndex = current
    this.syncCastQueue()
  },

  /** Moves the song at `from` to one of the queue's key positions: right
   * after the current song ('next' - after a locked next one, which
   * stays where it is) or to the very end. False where there is nothing
   * to do (see queueMoveTarget). */
  moveInQueue(from: number, where: QueueMoveTarget): boolean {
    const to = this.queueMoveTarget(from, where)
    if (to == null) return false
    this.reorderQueue(from, to)
    return true
  },

  /** Sorts the whole queue by its tagged BPM, slowest first, so
   * neighbouring songs are close enough in tempo to be beatmixed. Songs without a BPM tag keep their order at the end.
   * The current song keeps playing wherever it lands, and a locked next
   * song stays glued behind it (see lockedNextIndex). Like
   * reorderQueue(), it leaves originalQueue alone.
   *
   * Not while shuffle is on: the order would read as shuffled while being
   * sorted, and the next toggle of shuffle throws the sort away anyway -
   * it rebuilds the queue from originalQueue. */
  sortQueueByBpm(): void {
    if (this.shuffle) return
    const playing = this.queue[this.currentIndex]
    const lockedNext = this.queue[this.lockedNextIndex]
    const tagged = this.queue.filter((song) => song.bpm)
    const untagged = this.queue.filter((song) => !song.bpm)
    let queue = [...tagged.sort((a, b) => a.bpm! - b.bpm!), ...untagged]
    if (playing && lockedNext) queue = keptAfter(queue, queue.indexOf(playing), lockedNext)
    this.queue = queue
    if (playing) this.currentIndex = queue.indexOf(playing)
    this.syncCastQueue()
  },

  /** Drops everything from the queue except whatever's currently playing
   * — same "can't remove what's playing" rule removeFromQueue() already
   * enforces per-row, just applied to the whole queue at once. Radio has
   * no queue to clear (this.queue is already empty then; QueueDrawer.vue
   * only shows the button at all once there's more than the current
   * song to drop, see its own guard). Like every other queue-mutating
   * action here, pushes the result to connect via syncCastQueue() —
   * without it, this client's own next status tick would still carry the
   * pre-clear queue and adoptCastQueue() would restore it a few seconds
   * later, undoing the clear. */
  clearQueue(): void {
    // queuedSong — same reasoning as toggleShuffle()'s own use of it:
    // "clear everything but what's playing" keeps the queue's own
    // current entry, which outlives a radio station playing over it.
    const current = this.queuedSong
    if (!current) {
      this.originalQueue = []
      this.queue = []
      this.currentIndex = -1
      this.syncCastQueue()
      return
    }
    const lockedNext = this.queue[this.lockedNextIndex]
    this.originalQueue = lockedNext ? [current, lockedNext] : [current]
    this.queue = [...this.originalQueue]
    this.currentIndex = 0
    this.syncCastQueue()
  },
}
