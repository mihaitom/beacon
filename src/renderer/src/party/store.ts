import { defineStore } from 'pinia'
import {
  EVENTS_URL,
  PartyApiError,
  partyApi,
  type GuestAlbum,
  type GuestLyrics,
  type GuestSnapshot,
  type GuestSong,
  type ListenTimelineEntry,
} from './api'
import { ListenAlongPlayer, volumeAdjustable, type ListenState } from './listenAlong'

export type GuestPhase = 'loading' | 'join' | 'message' | 'app'
/** i18n keys under partyGuest.* for the full-page message screen. */
export type GuestMessage = 'ended' | 'rescan' | 'offline'

const NAME_KEY = 'beacon_party_name'
const VOLUME_KEY = 'beacon_party_volume'
// How often the extrapolated position is re-read - often enough for a
// lyrics line to light up on time, rare enough to cost nothing.
const CLOCK_TICK_MS = 250
// Lyrics kept per song, so the song a listening guest still hears keeps its
// lyrics after the host has moved on.
const LYRICS_KEPT = 4

/** What a listening guest hears, from the stream's timeline. */
export interface Heard {
  song: GuestSong | null
  position: number
  playing: boolean
}

export function heardAt(timeline: ListenTimelineEntry[], time: number): Heard | null {
  let entry: ListenTimelineEntry | null = null
  for (const candidate of timeline) {
    if (candidate.at <= time) entry = candidate
    else break
  }
  if (!entry) return null
  let position = entry.playing ? entry.position + (time - entry.at) : entry.position
  const duration = entry.song?.duration ?? 0
  if (duration > 0) position = Math.min(position, duration)
  return { song: entry.song, position, playing: entry.playing }
}

interface GuestState {
  phase: GuestPhase
  message: GuestMessage | null
  inviteToken: string | null
  snapshot: GuestSnapshot | null
  /** Server clock minus this device's, from the last snapshot - what turns
   * position_at into "now". Network delay is in it, which a lyric line
   * lighting up a few hundred ms late does not mind. */
  clockSkew: number
  /** This device's clock in seconds, re-read every CLOCK_TICK_MS. */
  now: number
  lyrics: GuestLyrics | null
  lyricsKey: string | null
  /** A lyrics fetch for lyricsKey is in flight. */
  lyricsLoading: boolean
  search: {
    query: string
    songs: GuestSong[]
    albums: GuestAlbum[]
    album: { album: GuestAlbum; songs: GuestSong[] } | null
    loading: boolean
    seq: number
  }
  /** Songs wished for from this page, so their buttons stay ticked. */
  wishedIds: string[]
  /** Lyrics by song id, the last LYRICS_KEPT loaded. */
  lyricsBySong: Record<string, GuestLyrics>
  listenState: ListenState
  /** The stream time this guest hears, re-read every CLOCK_TICK_MS while
   * listening; null until it is known. */
  listenTime: number | null
  /** This guest's own volume for the online party, 0..100. */
  volume: number
  /** False where the browser ignores a page's volume (iOS). */
  volumeAdjustable: boolean
  /** The waveform of displaySong, and which song it is for. */
  waveform: { songId: string | null; peaks: number[] }
}

let events: EventSource | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
// The lyrics_key `lyrics` was loaded for (see loadLyrics).
let loadedLyricsKey: string | null = null
let lyricsFetchSeq = 0
let hashWatcher: (() => void) | null = null
let player: ListenAlongPlayer | null = null

function readVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY))
    // A stored 0 comes back as full volume: a page that opens silent reads
    // as a stream that does not work.
    return Number.isFinite(stored) && stored > 0 && stored <= 100 ? stored : 100
  } catch {
    return 100
  }
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/** The token sits in the fragment, which never reaches a server or its
 * logs - and it leaves the address bar straight away so it doesn't end up
 * in a screenshot or a shared tab either. */
function takeInviteToken(): string | null {
  const match = window.location.hash.match(/^#t=([A-Za-z0-9_-]+)/)
  if (!match) return null
  history.replaceState(null, '', window.location.pathname)
  return match[1] ?? null
}

/** This page outlives the party: pasting a fresh invitation onto it changes
 * only the fragment, so the browser fires hashchange instead of reloading.
 * Watching for it - once, for the life of the page - is what lets a new link
 * join without a manual reload, from an ended page or anywhere else. */
function watchForInvite(): void {
  if (hashWatcher) return
  hashWatcher = () => {
    if (window.location.hash.startsWith('#t=')) void usePartyGuestStore().start()
  }
  window.addEventListener('hashchange', hashWatcher)
}

export const usePartyGuestStore = defineStore('partyGuest', {
  state: (): GuestState => ({
    phase: 'loading',
    message: null,
    inviteToken: null,
    snapshot: null,
    clockSkew: 0,
    now: Date.now() / 1000,
    lyrics: null,
    lyricsKey: null,
    lyricsLoading: false,
    search: { query: '', songs: [], albums: [], album: null, loading: false, seq: 0 },
    wishedIds: [],
    lyricsBySong: {},
    listenState: 'off',
    listenTime: null,
    volume: readVolume(),
    volumeAdjustable: volumeAdjustable(),
    waveform: { songId: null, peaks: [] },
  }),

  getters: {
    savedName: () => readName(),

    listenAvailable: (state): boolean => Boolean(state.snapshot?.listen?.enabled),

    /** Sound is coming, or about to again: playing or riding out a stall. */
    listening: (state): boolean =>
      state.listenState === 'playing' || state.listenState === 'buffering',

    /** What this guest hears while listening along, once the stream's
     * timeline says; null otherwise, when the host's view counts. */
    heard(state): Heard | null {
      if (state.listenState === 'off' || state.listenTime === null) return null
      return heardAt(state.snapshot?.listen?.timeline ?? [], state.listenTime)
    },

    /** The song to show: the one this guest hears while listening along
     * (a few seconds behind the host), else the host's. */
    displaySong(): GuestSong | null {
      const current = this.snapshot?.current_song ?? null
      const heard = this.heard
      if (!heard) return current
      // The host's copy carries who wished for it.
      return heard.song && current && heard.song.id === current.id ? current : heard.song
    },

    displayPlaying(): boolean {
      const heard = this.heard
      if (heard) return heard.playing && this.listenState === 'playing'
      return this.snapshot?.playing ?? false
    },

    displayDuration(): number {
      if (this.heard) return this.heard.song?.duration ?? 0
      return this.snapshot?.duration ?? 0
    },

    /** Where playback is now: what this guest hears while listening along,
     * else worked out from the last snapshot. */
    position(state): number {
      const heard = this.heard
      if (heard) return heard.position
      const snap = state.snapshot
      if (!snap) return 0
      if (!snap.playing) return snap.position
      const elapsed = state.now + state.clockSkew - snap.position_at
      const position = snap.position + Math.max(elapsed, 0)
      return snap.duration > 0 ? Math.min(position, snap.duration) : position
    },

    wishesLeft(state): number {
      if (!state.snapshot) return 0
      return Math.max(state.snapshot.limits.max_pending - state.snapshot.limits.pending, 0)
    },

    /** Lyrics that belong to the song shown now, or null. */
    currentLyrics(state): GuestLyrics | null {
      const song = this.displaySong
      if (!song) return null
      if (state.lyrics?.song_id === song.id) return state.lyrics
      return state.lyricsBySong[song.id] ?? null
    },
  },

  actions: {
    async start(): Promise<void> {
      watchForInvite()
      this.inviteToken = takeInviteToken()
      try {
        this.applySnapshot(await partyApi.state())
      } catch (error) {
        if (error instanceof PartyApiError && error.status === 401) {
          if (this.inviteToken) this.phase = 'join'
          else this.showMessage('rescan')
          return
        }
        this.showMessage(
          error instanceof PartyApiError && error.status === 404 ? 'ended' : 'offline',
        )
        return
      }
      // Already a guest: a fresh link for the same party needs no new join.
      this.inviteToken = null
      this.enter()
    },

    showMessage(message: GuestMessage): void {
      this.stop()
      this.message = message
      this.phase = 'message'
    },

    async join(name: string): Promise<void> {
      if (!this.inviteToken) return
      await partyApi.join(this.inviteToken, name)
      this.inviteToken = null
      try {
        localStorage.setItem(NAME_KEY, name)
      } catch {
        // Not remembering the name is fine.
      }
      this.applySnapshot(await partyApi.state())
      this.enter()
    },

    enter(): void {
      this.phase = 'app'
      this.connect()
      if (!clockTimer) {
        clockTimer = setInterval(() => {
          this.now = Date.now() / 1000
          if (player) this.listenTime = player.heardTime()
        }, CLOCK_TICK_MS)
      }
    },

    stop(): void {
      events?.close()
      events = null
      if (clockTimer) clearInterval(clockTimer)
      clockTimer = null
      this.stopListening()
    },

    /** Starts listening along. Straight from the guest's tap - browsers
     * only let sound start from inside one. */
    startListening(): void {
      player ??= new ListenAlongPlayer((state) => {
        this.listenState = state
        this.listenTime = player?.heardTime() ?? null
      })
      player.setVolume(this.volume / 100)
      player.play()
    },

    stopListening(): void {
      player?.stop()
      this.listenTime = null
    },

    setVolume(volume: number): void {
      this.volume = Math.min(Math.max(volume, 0), 100)
      player?.setVolume(this.volume / 100)
      try {
        localStorage.setItem(VOLUME_KEY, String(this.volume))
      } catch {
        // Still this volume for now.
      }
    },

    /** The waveform for `songId`, once per song. Asked for again only when
     * the song changes - connect decodes it fresh every time. */
    async loadWaveform(songId: string | null): Promise<void> {
      if (songId === this.waveform.songId) return
      this.waveform = { songId, peaks: [] }
      if (!songId) return
      try {
        const { peaks } = await partyApi.waveform(songId)
        if (this.waveform.songId === songId) this.waveform = { songId, peaks }
      } catch {
        // No waveform: the bar shows a plain line instead.
      }
    },

    /** The stream time heard this very moment - for the visualizer, which
     * needs it per animation frame rather than per CLOCK_TICK_MS. */
    heardTimeNow(): number | null {
      return player?.heardTime() ?? null
    },

    connect(): void {
      events?.close()
      events = new EventSource(EVENTS_URL, { withCredentials: true })
      events.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as GuestSnapshot | { ended: true }
        if ('ended' in data) {
          void this.recheck()
          return
        }
        this.applySnapshot(data)
      }
      events.onerror = () => {
        // CLOSED means the browser gave up for good (an error answer, not
        // a dropped connection, which it retries by itself).
        if (events?.readyState === EventSource.CLOSED) void this.recheck()
      }
    },

    /** The stream ended: the party, this guest's place in it, or just a
     * server restart. Asking tells them apart. */
    async recheck(): Promise<void> {
      events?.close()
      events = null
      try {
        this.applySnapshot(await partyApi.state())
        this.connect()
      } catch {
        this.showMessage('ended')
      }
    },

    applySnapshot(snapshot: GuestSnapshot): void {
      this.now = Date.now() / 1000
      this.clockSkew = snapshot.position_at - this.now
      this.snapshot = snapshot
      if (this.listenState !== 'off') {
        // The host switched listening along off, or the stream restarted.
        if (!snapshot.listen?.enabled) this.stopListening()
        else player?.followEpoch(snapshot.listen.epoch)
      }
      if (snapshot.lyrics_key !== this.lyricsKey) {
        this.lyricsKey = snapshot.lyrics_key
        void this.loadLyrics()
      }
    },

    async loadLyrics(): Promise<void> {
      const key = this.lyricsKey
      // Only the latest call says whether a fetch is still running.
      const seq = ++lyricsFetchSeq
      // Already here: a key that went away and came back (the host's
      // window waking, a song change seen twice) is no reason to ask again,
      // and asking on every flip runs into the rate limit.
      if (!key || (key === loadedLyricsKey && this.lyrics)) {
        this.lyricsLoading = false
        return
      }
      this.lyricsLoading = true
      try {
        this.lyrics = await partyApi.lyrics()
        loadedLyricsKey = key
        this.keepLyrics(this.lyrics)
      } catch {
        this.lyrics = null
        loadedLyricsKey = null
      } finally {
        if (seq === lyricsFetchSeq) this.lyricsLoading = false
      }
    },

    keepLyrics(lyrics: GuestLyrics): void {
      if (!lyrics.song_id || !lyrics.lines.length) return
      const kept = { ...this.lyricsBySong, [lyrics.song_id]: lyrics }
      const ids = Object.keys(kept)
      for (const id of ids.slice(0, Math.max(ids.length - LYRICS_KEPT, 0))) delete kept[id]
      this.lyricsBySong = kept
    },

    async runSearch(query: string): Promise<void> {
      const seq = ++this.search.seq
      this.search.query = query
      this.search.album = null
      if (!query) {
        this.search.songs = []
        this.search.albums = []
        return
      }
      this.search.loading = true
      try {
        const [songs, albums] = await Promise.all([partyApi.songs(query), partyApi.albums(query)])
        if (seq !== this.search.seq) return // a newer search has started
        this.search.songs = songs.items
        this.search.albums = albums.items
      } finally {
        if (seq === this.search.seq) this.search.loading = false
      }
    },

    async openAlbum(id: string): Promise<void> {
      this.search.album = await partyApi.album(id)
    },

    async wish(song: GuestSong): Promise<void> {
      await partyApi.wish(song.id)
      this.wishedIds.push(song.id)
    },

    async withdraw(requestId: string): Promise<void> {
      await partyApi.withdraw(requestId)
    },

    async toggleSkip(): Promise<void> {
      await (this.snapshot?.skip.mine ? partyApi.unskip() : partyApi.skip())
    },
  },
})
