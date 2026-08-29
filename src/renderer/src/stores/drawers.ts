import { defineStore } from 'pinia'
import type { Song } from '@/types/library'

/** The queue and lyrics drawers: whether they are open, and the reveal
 * animation QueueDrawer.vue plays when the queue changes underneath it.
 *
 * Split out of stores/playback.ts (2026-08-29), where this had grown up
 * alongside the queue itself: it is interface state, not playback state -
 * nothing here survives a reload, none of it is sent to connect, and no
 * playback decision reads it. The store still drives it (playSongList()/
 * addToQueue()/queueNext() call peekQueueDrawer), but only ever in one
 * direction, so this file knows nothing about playback.
 *
 * That one-way rule is why peekQueueDrawer() takes the songs to reveal as
 * a required argument: it used to default to the playback store's own
 * queue, which would mean reaching back into it from here. Callers that
 * mean "the whole queue" now say so explicitly. */

// How long peekQueueDrawer() leaves the drawer open before auto-closing it
// again, absent a mouseenter (cancelQueueDrawerAutoCloseTimer()) telling it
// the user's actually looking. Long enough to register "oh, that's what got
// picked" at a glance, short enough not to just sit open indefinitely for
// someone who's moved on.
const QUEUE_DRAWER_PEEK_MS = 4000

// setTimeout handle for the above — module-level, not store state: a plain
// timer id isn't something Pinia needs to track/persist/react to.
let queueDrawerAutoCloseTimer: ReturnType<typeof setTimeout> | null = null

function cancelQueueDrawerAutoCloseTimer(): void {
  if (queueDrawerAutoCloseTimer === null) return
  clearTimeout(queueDrawerAutoCloseTimer)
  queueDrawerAutoCloseTimer = null
}

function armQueueDrawerAutoCloseTimer(store: { queueDrawerOpen: boolean }): void {
  cancelQueueDrawerAutoCloseTimer()
  queueDrawerAutoCloseTimer = setTimeout(() => {
    queueDrawerAutoCloseTimer = null
    store.queueDrawerOpen = false
  }, QUEUE_DRAWER_PEEK_MS)
}

interface DrawersState {
  queueDrawerOpen: boolean
  // Bumped by peekQueueDrawer() specifically — QueueDrawer.vue watches
  // this (not queueDrawerOpen) to know a staggered reveal is actually
  // warranted, as opposed to a plain manual toggle-open of an otherwise
  // unchanged queue, which should just show it as-is with no fanfare.
  queueRevealSeq: number
  // Whether *this* peekQueueDrawer() call is the one actually opening the
  // drawer from closed, set alongside queueRevealSeq above — see
  // QueueDrawer.vue's own startReveal(), which needs to wait out the
  // drawer's own opening transition before revealing anything in that
  // case, but not when the drawer was already open and visible (a
  // mid-queue "Play Next" while watching it, say) and the reveal should
  // just start immediately instead.
  queueRevealNeedsOpenDelay: boolean
  // Exactly which songs QueueDrawer.vue's reveal animation should treat as
  // new, set by peekQueueDrawer() at the same moment as queueRevealSeq —
  // see that action's own comment on why this has to be an explicit list
  // handed down from here, not something QueueDrawer.vue can work out for
  // itself by watching what it's already rendered.
  queueRevealSongs: Song[]
  lyricsDrawerOpen: boolean
}

export const useDrawersStore = defineStore('drawers', {
  state: (): DrawersState => ({
    queueDrawerOpen: false,
    queueRevealSeq: 0,
    queueRevealNeedsOpenDelay: false,
    queueRevealSongs: [],
    lyricsDrawerOpen: false,
  }),

  actions: {
    // Routes every manual open/close through here (DefaultLayout.vue's own
    // v-model listener, toggleQueueDrawer() below) instead of setting
    // queueDrawerOpen directly, so a still-pending peekQueueDrawer() timer
    // (see its own comment) always gets cancelled first — without this, a
    // stale timer could auto-close a drawer the user had just reopened
    // manually within that same few-second window.
    setQueueDrawerOpen(open: boolean): void {
      cancelQueueDrawerAutoCloseTimer()
      this.queueDrawerOpen = open
    },

    toggleQueueDrawer(): void {
      this.setQueueDrawerOpen(!this.queueDrawerOpen)
    },

    // Called by every action that replaces the queue, with one exception:
    // a single song that plays immediately (playSongList([song], 0) —
    // clicking a bare song in raw-browsing SongTable, the mobile action
    // sheet, the phone remote's play-song) needs no peek, since there's
    // nothing about the resulting one-row queue the click itself didn't
    // already show. Everything else that replaces the queue peeks, even a
    // whole album/playlist/curated-list play the user was already looking
    // at (AlbumCard, HomeView's hero/shelf plays, PlaylistsView/
    // PlaylistDetailView's playAll, SongTable's curated-list click and
    // multi-selection play) — changed 2026-08-26 from only peeking for
    // picks the user didn't make song-by-song (server mixes, quick-play
    // random/top actions), which is still also covered but no longer the
    // dividing line. addToQueue()/queueNext() reach it too (a song's
    // context menu, the mobile action sheet, remote-control commands, and
    // maybeAutoplay()'s own top-up, all funneled through those two) even
    // though they don't replace the queue — appending is exactly as easy
    // to miss as replacing. Callers that replace it pass `peek` straight
    // into playSongList() (see its own comment for why the peek has to
    // happen inside that call rather than after it) or call this directly
    // right after their own mutation, same timing requirement either way.
    // The phone remote's own play-playlist is one of these: it runs
    // through commands.ts on the desktop process actually holding the
    // queue, so the peek opens the desktop's drawer, not anything on the
    // phone — the phone has no queue drawer of its own to peek into, is
    // sending this command precisely because it isn't looking at the
    // desktop, and mobile web has no drawer either, so no callers there
    // pass `peek` regardless of what they replace.
    // queueRevealSeq always bumps (that's the "show me what got added"
    // signal QueueDrawer.vue's own reveal animation watches for — see its
    // own comment), even if the drawer was already open from an earlier
    // peek/manual toggle. The auto-close timer only arms when this call is
    // the one actually opening it, though: a drawer the user already had
    // open manually is left alone entirely otherwise — imposing an
    // auto-close on state they set up themselves would be surprising.
    // `revealSongs` is exactly which songs QueueDrawer.vue's reveal
    // animation should treat as new — omit it (every replace-the-whole-
    // queue caller: startSongRadio(), startArtistRadio(), every "play
    // random"/"play from top played" action) to mean "the entire current
    // queue", since every one of those really did just become entirely
    // new. addToQueue()/queueNext() pass the specific songs they just
    // added instead, so only those get revealed — not rows that were
    // already sitting there and merely shifted position.
    //
    // This can't be inferred by QueueDrawer.vue itself from what it has or
    // hasn't rendered yet (an earlier version tried exactly that, checking
    // a WeakMap of already-seen Song objects): by the time it renders, the
    // songs are simply there, with nothing marking which of them the user
    // hasn't seen before. Reported live 2026-08-25 as "no animation when
    // the queue regenerates while the drawer's open".
    //
    // Every caller has to reach here in the same synchronous tick as its
    // own queue mutation, so that both land in one render — the reveal is
    // just per-row transition delays (see QueueDrawer.vue), which do
    // nothing for a row Vue already rendered and animated an await ago.
    peekQueueDrawer(revealSongs: Song[]): void {
      const wasAlreadyOpen = this.queueDrawerOpen
      this.queueDrawerOpen = true
      this.queueRevealNeedsOpenDelay = !wasAlreadyOpen
      this.queueRevealSongs = revealSongs
      this.queueRevealSeq++
      // Re-arms, not just arms — a peek landing while an *earlier* peek's
      // own auto-close timer is still counting down (autoplay's top-up
      // right on the heels of the reveal it just opened for, say) must not
      // let that stale countdown cut the fresh one off partway through.
      // queueDrawerAutoCloseTimer !== null is exactly the right signal for
      // "still open because of a peek, not because of the user": a manual
      // open and a mouseenter (cancelQueueDrawerAutoClose()) both clear it,
      // and nothing else ever sets it besides armQueueDrawerAutoCloseTimer()
      // itself — so it still being set here can only mean an unexpired peek
      // countdown, never state the user set up themselves that this
      // shouldn't touch. Reported live 2026-08-27 as the drawer closing out
      // from under a reveal that had only just started.
      if (!wasAlreadyOpen || queueDrawerAutoCloseTimer !== null) armQueueDrawerAutoCloseTimer(this)
    },

    // QueueDrawer.vue's own @mouseenter — one touch of the mouse is enough
    // to mean "I'm actually looking at this", cancelling the pending
    // auto-close for good (not just deferring it), so it then stays open
    // the same as if it had been opened manually.
    cancelQueueDrawerAutoClose(): void {
      cancelQueueDrawerAutoCloseTimer()
    },

    toggleLyricsDrawer(): void {
      this.lyricsDrawerOpen = !this.lyricsDrawerOpen
    },

    /** Both drawers closed, any pending auto-close dropped. Called by the
     * playback store on init() (a fresh app start always begins with both
     * closed - none of this was ever meant to survive a restart) and on
     * logout. */
    resetDrawers(): void {
      cancelQueueDrawerAutoCloseTimer()
      this.$reset()
    },
  },
})
