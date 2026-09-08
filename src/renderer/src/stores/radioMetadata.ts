import { defineStore } from 'pinia'
import { getAudioEngine } from '@/services/audioEngine'
import { pollingAllowed } from '@/services/connect/pollGate'
import {
  fetchRadioMetadata,
  fetchRadioTitleHistory,
  searchRadioTitleHistory,
  RADIO_TITLE_PAGE_SIZE,
  type RadioTitleEntry,
} from '@/services/connect/radioMetadata'
import { createSequenceGuard } from '@/services/playback/sequenceGuard'
import { usePlaybackStore } from './playback'

// A radio title that has arrived from the backend but is not on screen
// yet, because the audio it belongs to has not been played out of this
// device's buffer — see poll(). The timer and the title it is holding, so
// a second poll reporting the same title does not re-arm it, and `url` so
// a station change can tell whose it was.
let pendingTitle: { title: string | null; url: string } | null = null
let pendingTitleTimer: ReturnType<typeof setTimeout> | null = null

// True while loadOlder() has a page request out. Module-level rather than
// store state for the same reason as pendingTitle above: nothing renders
// it, and the scroll handler that triggers the load fires far more often
// than the request completes.
let pageInFlight = false

// Only the newest search may write its results: typing "wonder" fires one
// request per keystroke past the debounce, and a slower earlier one landing
// afterwards would put the matches for "wond" under the word on screen.
const searchGuard = createSequenceGuard()

// How often the metadata poll asks while the backend is still catching up
// with a station that has just been started, and how many times before it
// gives up and leaves the 8s interval to it. Roughly 20 seconds of it: a
// relay has to connect to the station, and a slow one still gets its log
// on screen without the reader waiting out a whole interval on top.
const CATCHUP_INTERVAL_MS = 1000
const CATCHUP_TRIES = 20

let catchupTimer: ReturnType<typeof setInterval> | null = null

function stopCatchup(): void {
  if (catchupTimer !== null) clearInterval(catchupTimer)
  catchupTimer = null
}

// A ceiling on the hold in poll(). The buffer it is read from is normally a
// handful of seconds; a much larger reading means something unusual
// (a stall that refilled hugely, a browser deciding to fetch far ahead),
// and holding a title for a minute is worse than showing it early.
const MAX_TITLE_HOLD_SECONDS = 30

export interface RadioMetadataState {
  /** The current station's own ICY "now playing" tag (services/connect/
   * radioMetadata.ts) — null both before the backend's watch has seen one
   * yet and for a station with no ICY support at all; callers don't need
   * to tell those apart (see fetchRadioMetadata()'s own docstring).
   * Cleared by reset() everywhere the station itself changes, so a stale
   * title from the *previous* station never lingers even briefly on
   * screen while the poll below catches up to the new one. */
  nowPlaying: string | null
  /** Every title the current station has played this session, newest
   * first — Now Playing shows this in place of the lyrics a radio
   * station never has (RadioTitleLog.vue). Kept per station by the backend
   * (see connect/core/session.py's radio_title_history), so switching away
   * and back finds this station's own log rather than a merged one; reset
   * here alongside nowPlaying purely so the previous station's log is
   * never on screen while the poll catches up.
   *
   * Almost unfiltered — a station sends its programme name, its own
   * slogan and news items through the very same field a song comes
   * through, and the slogan carries the same "Artist - Title" shape a song
   * does, so anything that dropped headlines would drop songs with it.
   * Telling those apart is left to the display. The single exception is
   * made by the backend before this ever sees it: an ad break, which a
   * station marks by putting the advertiser's own domain where a song has
   * its artist (see connect/core/radio_ads.py).
   *
   * Only the part that has actually been fetched: the newest page arrives
   * with the first poll of a station and older ones follow as the reader
   * scrolls back through them (see loadOlder()). Every poll after that
   * carries the delta alone — see the poll interval in the playback
   * store's init() for what asking for the whole thing every eight seconds
   * used to cost. */
  titleLog: RadioTitleEntry[]
  /** Whether titleLog has reached the beginning of the backend's log for
   * this station, so there is nothing older left to ask for. Set from a
   * page that came back shorter than it could have been, which is the only
   * signal there is — deliberately, since a separate flag from the backend
   * would be one more thing that can disagree with the list it
   * describes. */
  titleLogComplete: boolean
  /** The search in force over the station's title log, and what it
   * matched — both empty whenever nothing is being searched for, which is
   * what the log itself is shown for.
   *
   * Separate from titleLog rather than filtering it in place: that list is
   * what the 8s poll appends to and what paging extends, and a search
   * answers from the backend's whole log instead (see
   * searchRadioTitleHistory()). Keeping the two apart is what lets a
   * search be dropped without re-fetching the log behind it.
   */
  searchQuery: string
  searchResults: RadioTitleEntry[]
  /** A search request is out. Rendered as a quiet state on the search row
   * rather than as an empty result, which reads as "nothing found" for
   * however long the round trip takes. */
  searchPending: boolean
  /** What the current station declares it broadcasts at (kbps) and what it
   * is encoded as — both null for a station that declares neither, and for
   * the moment before the first poll answers. Read straight off the
   * station's own ICY headers by the backend (see connect/core/
   * icy_metadata.py), so they describe the station itself rather than
   * whatever Beacon may be re-encoding it to for a cast device, and read
   * the same locally and while casting. Shown by StreamInfoSection.vue,
   * which has nothing else to say about a station. */
  bitrate: number | null
  codec: string | null
  /** What Beacon's relay is handing this device for the current station,
   * and why it is not simply passing it through — null while it is (the
   * common case) and for a station played straight from its own URL. The
   * stream panel reads these for local playback, where there is no cast
   * status to read them from. */
  relayBitrate: number | null
  relayReason: string | null
  relayContentType: string | null
}

/** Everything the backend can say *about* the station that is playing: its
 * ICY "now playing" tag, its title log and what it broadcasts at.
 *
 * A store of its own rather than more of the playback store, because none
 * of this is playback state. Nothing here decides what comes out of a
 * speaker, none of it is persisted across a reload, and all of it is
 * answered by the one poll below. What *is* playback's — which station is
 * current, whether it is buffering, whether this device gave up
 * reconnecting — stays there, and the dependency runs one way only: this
 * store reads playback.radioStation and never writes it.
 *
 * The poll itself is driven from the playback store's init(), which owns
 * the app-lifetime intervals. */
export const useRadioMetadataStore = defineStore('radioMetadata', {
  state: (): RadioMetadataState => ({
    nowPlaying: null,
    titleLog: [],
    titleLogComplete: false,
    searchQuery: '',
    searchResults: [],
    searchPending: false,
    bitrate: null,
    codec: null,
    relayBitrate: null,
    relayReason: null,
    relayContentType: null,
  }),

  getters: {
    /** Whether a search is actually narrowing anything, as opposed to a
     * field that merely has something in it. Whitespace alone is not a
     * search — it fetches nothing (see search()) and must not hide the log
     * behind an empty result list either. */
    hasActiveSearch: (state): boolean => state.searchQuery.trim() !== '',
  },

  actions: {
    /** One round of the ICY "now playing" poll (services/connect/
     * radioMetadata.ts): the current station's title, what it has played
     * since the newest entry already held, and what it broadcasts at.
     * Pushed from the connect backend's own watch rather than derived
     * locally, since a plain HTML5 <audio> element never sees any of it.
     *
     * Called on a timer from the playback store's init() and, at a faster
     * cadence, right after a station starts - see startCatchup(). A no-op
     * when no station is playing, so both callers can fire it
     * unconditionally. */
    poll(): void {
      const playback = usePlaybackStore()
      const station = playback.radioStation
      if (!station) return
      // The newest entry already on screen is what this asks to be
      // brought up to date from; without one (a station just started, a
      // reload) the backend hands over its newest page instead. A title
      // being held back below deliberately does not count as held: it is
      // not in the log yet, so it keeps being re-delivered until it is,
      // which costs one entry per poll and needs no buffer of its own.
      fetchRadioMetadata(this.titleLog[0]?.at)
        .then((metadata) => {
          // The station may have changed while this was in flight - a
          // stale answer for the *previous* one must never overwrite
          // this one's (already-reset-to-null) title.
          if (playback.radioStation?.streamUrl !== station.streamUrl) return
          // And the other half of the same question, which this side
          // cannot answer on its own: whether the *backend* had caught up
          // with the switch when it answered. It reaches a station on its
          // own schedule - a relayed station only becomes current there
          // once this device's player has opened the new stream and the
          // relay has connected to the station, a second or more after the
          // click - and until then it answers, correctly for its own
          // state, with the previous station's title and log. Applied
          // blindly that put one station's history under another one's
          // name, and it stayed there: every later poll asks for what is
          // newer than the newest entry held, so nothing ever replaced it
          // short of a reload. Reported live 2026-09-07.
          //
          // A null url is not a mismatch: it is both "no station current
          // there" (nothing to apply anyway) and what a connect too old to
          // send it answers, which must keep working.
          if (metadata.url !== null && metadata.url !== station.streamUrl) return
          // Whatever the poll was waiting for has arrived, so the faster
          // cadence a station start turns on has done its job.
          stopCatchup()
          // Immediately, both of them: they describe the station itself,
          // not a moment in it, so there is nothing to line them up with.
          this.bitrate = metadata.bitrate
          this.codec = metadata.codec
          // Same "describes the station, not a moment in it" reasoning as
          // the two above — see the relay's own note in routes/radio.py.
          this.relayBitrate = metadata.relayBitrate
          this.relayReason = metadata.relayReason
          this.relayContentType = metadata.relayContentType

          const showTitle = () => {
            this.nowPlaying = metadata.title
            this.applyDelta(metadata.history)
          }
          // Nothing new to line up. The log still moves, unless a title
          // is being held — then its newest entry is the held one, and
          // letting it through would put the song on screen in the list
          // while the line above it still shows the previous one.
          if (metadata.title === this.nowPlaying || metadata.title === pendingTitle?.title) {
            if (pendingTitleTimer === null) this.applyDelta(metadata.history)
            return
          }

          // The backend reads the station's tag at the live edge, but
          // this device is playing out of a buffer that was handed to it
          // as fast as the network allowed - a station's own
          // burst-on-connect, or the relay's head start
          // (connect/core/streamer.py's LOOKAHEAD_SECONDS, measured at
          // ~15s). Showing the tag when it arrives therefore announces
          // the next song while the previous one is still audibly
          // playing. Held back by exactly what this element has buffered
          // ahead, which is the same number (see the engine's
          // bufferedAhead).
          //
          // Only for local playback: while casting, the buffer that
          // matters belongs to the speaker and nothing here can measure
          // it, so a hold would be a guess laid on top of an unknown.
          //
          // How much that is in practice, measured live 2026-09-06 on a
          // relayed station: 2.4s half a minute in, 0.3s twelve minutes
          // in. Small, and shrinking — the relay delivers at exactly 1x
          // (core/streamer.py's -readrate), so a player can never build
          // a lead, and the head start it is handed on connect is spent
          // for good the first time a stall eats into it. So this
          // corrects a few seconds early on and almost nothing later,
          // which is worth having and is not the whole gap: with 2.4s
          // held, a counted track change still showed 4s before it was
          // audible. The rest sits between the tag being demuxed on the
          // relay's *input* side and that audio leaving ffmpeg, and is
          // not measured yet — see TODO.md before adding a constant for
          // it.
          const holdSeconds = playback.isCasting
            ? 0
            : Math.min(getAudioEngine().bufferedAhead, MAX_TITLE_HOLD_SECONDS)
          if (holdSeconds <= 0) {
            this.cancelPendingTitle()
            showTitle()
            return
          }
          this.cancelPendingTitle()
          pendingTitle = { title: metadata.title, url: station.streamUrl }
          pendingTitleTimer = setTimeout(() => {
            pendingTitleTimer = null
            pendingTitle = null
            // Same guard as above, for the wait rather than the request:
            // a station change during the hold makes this title somebody
            // else's.
            if (playback.radioStation?.streamUrl !== station.streamUrl) return
            showTitle()
          }, holdSeconds * 1000)
        })
        .catch(() => {})
    },

    /** Drops a title that is being held back, without showing it — the
     * connection it was measured against is being replaced (see the
     * playback store's startLocalRadio()), so the buffer it was lined up
     * with no longer exists. */
    cancelPendingTitle(): void {
      if (pendingTitleTimer !== null) clearTimeout(pendingTitleTimer)
      pendingTitleTimer = null
      pendingTitle = null
    },

    /** Polls faster than the 8s interval for as long as it takes the
     * backend to catch up with a station this device has just started.
     *
     * Without it the title log arrives up to a full interval late, and
     * later than that in the usual (relayed) case: the backend only knows
     * which station is current once the player has opened the new stream
     * and the relay has connected to it, so the first poll after a click
     * is normally still answered for the station before it and dropped.
     * That read as "the log only appears once the station is buffered",
     * which is exactly what it was.
     *
     * Stops on the first answer that is actually for this station (see
     * poll()), and gives up after CATCHUP_TRIES either way - a station
     * whose stream never comes up must not leave a poll running at this
     * rate for as long as it is on screen. */
    startCatchup(): void {
      stopCatchup()
      let tries = 0
      const tick = () => {
        if (!usePlaybackStore().radioStation || ++tries > CATCHUP_TRIES) {
          stopCatchup()
          return
        }
        // Same gate as the poll interval in the playback store's init(): a
        // hidden window has nobody to show a title to, and its return
        // polls on its own.
        if (pollingAllowed()) this.poll()
      }
      catchupTimer = setInterval(tick, CATCHUP_INTERVAL_MS)
      tick()
    },

    /** Drops everything this store holds, because the station it describes
     * has stopped being the current one — the tag, the log, how much of it
     * has been fetched, and what the station broadcasts at. Called from
     * every place the playback store changes stations, which is the moment
     * all of it stops meaning anything. */
    reset(): void {
      // Every caller is a station ceasing to be the current one, so a
      // catch-up still running is one for a station nobody is on any more.
      // The callers that go on to start a *new* station arm it again
      // themselves, after this.
      stopCatchup()
      this.cancelPendingTitle()
      this.nowPlaying = null
      this.bitrate = null
      this.codec = null
      this.relayBitrate = null
      this.relayReason = null
      this.relayContentType = null
      this.titleLog = []
      this.titleLogComplete = false
      pageInFlight = false
      // A search is about one station's log, so it cannot survive into the
      // next one — the results would be another station's evening under
      // this one's name.
      this.clearSearch()
    },

    /** Puts what a poll brought back at the top of the log.
     *
     * `entries` is newest-first and, on every poll after the first, holds
     * only what is newer than the entry the request named — so this is a
     * prepend, not a replacement. The filter is for the first poll of a
     * station, which asks for a whole page rather than a delta, and for
     * the case of an answer overtaking a newer one that already landed:
     * either way, only what is genuinely newer than the current head goes
     * in, and a repeated entry is dropped rather than duplicated.
     *
     * Whether the log is complete is decided here too, and only on that
     * first page: a first page shorter than the backend's own page size is
     * the entire log, so there is nothing for a scroll to fetch later. */
    applyDelta(entries: RadioTitleEntry[]): void {
      const head = this.titleLog[0]
      if (!head) {
        this.titleLog = entries
        this.titleLogComplete = entries.length < RADIO_TITLE_PAGE_SIZE
        return
      }
      const fresh = entries.filter((entry) => entry.at > head.at)
      if (fresh.length) this.titleLog = [...fresh, ...this.titleLog]
    },

    /** Fetches the page of titles before the oldest one held, for the
     * reader who has scrolled to the end of what is on screen (see
     * RadioTitleLog.vue, which asks as the bottom comes into reach rather
     * than offering a button).
     *
     * Safe to call on every scroll event: it returns immediately once the
     * beginning of the log has been reached and while a page is already in
     * flight, which is what the scroll handler relies on instead of
     * throttling itself.
     *
     * A failed page is not remembered as anything: nothing is appended, no
     * flag moves, and the next scroll simply asks again. */
    async loadOlder(): Promise<void> {
      if (this.titleLogComplete || pageInFlight) return
      const oldest = this.titleLog[this.titleLog.length - 1]
      const playback = usePlaybackStore()
      const station = playback.radioStation
      if (!oldest || !station) return

      pageInFlight = true
      try {
        const page = await fetchRadioTitleHistory(oldest.at)
        // The station may have changed while this was in flight — that
        // page belongs to a log nobody is looking at any more. Both halves
        // of it, exactly as the poll checks them: whether this client has
        // moved on, and whether the backend had already moved on when it
        // answered (see poll() for what that window is).
        if (playback.radioStation?.streamUrl !== station.streamUrl) return
        if (page.url !== null && page.url !== station.streamUrl) return
        if (page.history.length) this.titleLog = [...this.titleLog, ...page.history]
        if (page.history.length < RADIO_TITLE_PAGE_SIZE) this.titleLogComplete = true
      } catch (error) {
        console.error('[radio-metadata] Failed to load older titles:', error)
      } finally {
        pageInFlight = false
      }
    },

    /** Searches the station's whole log for `query`, replacing what the
     * title list shows for as long as one is in force. An empty query is
     * how a search is dropped, so the caller needs no second action for
     * "stop searching".
     *
     * Asked of the backend rather than filtered here: this client holds
     * the newest page or three, and the entry somebody is looking for is
     * usually the one they did not scroll to. See
     * searchRadioTitleHistory().
     *
     * The station is checked on the way back exactly as loadOlder() checks
     * it, and for the same reason — both halves, since either side can
     * have moved on while this was in flight. */
    async search(query: string): Promise<void> {
      const trimmed = query.trim()
      // Deliberately the raw text, not `trimmed`: this is what the search
      // field displays (NowPlayingView passes it straight back down as
      // `query`), and a field whose value is rewritten as it is typed
      // cannot be typed into. Handing back the trimmed text meant the
      // space in "kate bush" was deleted the moment the debounce landed,
      // which reads as a field that refuses spaces. Only the *request*
      // below is trimmed, which is the only place it ever mattered.
      this.searchQuery = query
      const token = searchGuard.begin()
      if (!trimmed) {
        // begin() above is what makes this cancel rather than merely
        // clear: a request already out for the text that was just deleted
        // can no longer write its results.
        this.searchResults = []
        this.searchPending = false
        return
      }

      const playback = usePlaybackStore()
      const station = playback.radioStation
      if (!station) return
      this.searchPending = true
      try {
        const page = await searchRadioTitleHistory(trimmed)
        if (!searchGuard.isCurrent(token)) return
        if (playback.radioStation?.streamUrl !== station.streamUrl) return
        if (page.url !== null && page.url !== station.streamUrl) return
        this.searchResults = page.history
      } catch (error) {
        console.error('[radio-metadata] Title search failed:', error)
      } finally {
        // Only the latest search owns the pending state — an older one
        // finishing late would otherwise clear it while the current
        // request is still out.
        if (searchGuard.isCurrent(token)) this.searchPending = false
      }
    },

    clearSearch(): void {
      void this.search('')
    },
  },
})
