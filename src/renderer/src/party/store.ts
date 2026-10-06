import { defineStore } from 'pinia'
import {
  EVENTS_URL,
  PartyApiError,
  partyApi,
  type GuestAlbum,
  type GuestLyrics,
  type GuestSnapshot,
  type GuestSong,
} from './api'

export type GuestPhase = 'loading' | 'join' | 'message' | 'app'
/** i18n keys under partyGuest.* for the full-page message screen. */
export type GuestMessage = 'ended' | 'rescan' | 'offline'

const NAME_KEY = 'beacon_party_name'
// How often the extrapolated position is re-read - often enough for a
// lyrics line to light up on time, rare enough to cost nothing.
const CLOCK_TICK_MS = 250

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
}

let events: EventSource | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
// The lyrics_key `lyrics` was loaded for (see loadLyrics).
let loadedLyricsKey: string | null = null

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
    search: { query: '', songs: [], albums: [], album: null, loading: false, seq: 0 },
    wishedIds: [],
  }),

  getters: {
    savedName: () => readName(),

    /** Where playback is now, worked out from the last snapshot. */
    position(state): number {
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

    /** Lyrics that belong to the song playing now, or null. */
    currentLyrics(state): GuestLyrics | null {
      const song = state.snapshot?.current_song
      return song && state.lyrics?.song_id === song.id ? state.lyrics : null
    },
  },

  actions: {
    async start(): Promise<void> {
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
        }, CLOCK_TICK_MS)
      }
    },

    stop(): void {
      events?.close()
      events = null
      if (clockTimer) clearInterval(clockTimer)
      clockTimer = null
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
      if (snapshot.lyrics_key !== this.lyricsKey) {
        this.lyricsKey = snapshot.lyrics_key
        void this.loadLyrics()
      }
    },

    async loadLyrics(): Promise<void> {
      const key = this.lyricsKey
      if (!key) return
      // Already here: a key that went away and came back (the host's
      // window waking, a song change seen twice) is no reason to ask again,
      // and asking on every flip runs into the rate limit.
      if (key === loadedLyricsKey && this.lyrics) return
      try {
        this.lyrics = await partyApi.lyrics()
        loadedLyricsKey = key
      } catch {
        this.lyrics = null
        loadedLyricsKey = null
      }
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
