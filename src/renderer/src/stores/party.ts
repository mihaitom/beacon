import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import {
  disableParty,
  enableParty,
  getPartyStatus,
  kickPartyGuest,
  rotatePartyLink,
  updatePartySettings,
  type PartyGuest,
  type PartyStatus,
} from '@/services/party/http'
import type { Song } from '@/types/library'
import { usePlaybackStore } from './playback'
import { useRemoteControlStore } from './remoteControl'
import { useLyricsStore } from './lyrics'
import { useFanartStore } from './fanart'
import { fanartSource, getArtistArt, shownBackgroundSource } from '@/services/connect/fanart'
import { pushPartyLyrics } from '@/services/party/http'

/** One guest's wish, tied to the exact queue entry it put there - by
 * object, not by id, so the same song queued twice is still two entries. */
export interface PartyRequest {
  id: string
  song: Song
  guestId: string
  guestName: string
  requestedAt: number
}

export interface PartySettings {
  maxPendingPerGuest: number
  /** Share of connected guests needed to skip; 0 switches skipping off. */
  skipRatio: number
  durationHours: number
  /** Where guests reach this Beacon from outside, e.g. behind a reverse
   * proxy. Empty means the address this app already knows. */
}

/** A refusal the guest should see as such, not as a failure. Its string
 * form is the bare code, because that is what the command relay hands back
 * to connect (stores/remoteControl.ts's onCommand), and connect maps the
 * code to a status (routes/party.py's _REFUSALS). */
export class PartyRefusal extends Error {
  constructor(public readonly code: 'limit' | 'duplicate' | 'not-found' | 'forbidden' | 'radio') {
    super(code)
  }

  override toString(): string {
    return this.code
  }
}

interface PartyState {
  enabled: boolean
  /** Whether this window is the one answering guests. In the web build
   * every open tab would otherwise pick the party up and apply each wish
   * once per tab. */
  hostedHere: boolean
  /** Only known right after this session started the party or renewed the
   * link - /party-host/status never sends it. */
  inviteToken: string | null
  expiresAt: number | null
  lanIp: string
  port: number
  guests: PartyGuest[]
  requests: PartyRequest[]
  settings: PartySettings
}

const SETTINGS_KEY = 'beacon_party_settings'
// Per tab and surviving a reload - see hostedHere.
const HOST_KEY = 'beacon_party_host'
const STATUS_POLL_MS = 10_000

const DEFAULT_SETTINGS: PartySettings = {
  maxPendingPerGuest: 3,
  skipRatio: 0.5,
  durationHours: 12,
}

function markHost(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(HOST_KEY, '1')
    else sessionStorage.removeItem(HOST_KEY)
  } catch {
    // Without storage a reload simply has to take the party over again.
  }
}

function wasHost(): boolean {
  try {
    return sessionStorage.getItem(HOST_KEY) === '1'
  } catch {
    return false
  }
}

function loadSettings(): PartySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let statusTimer: ReturnType<typeof setInterval> | null = null
let unsubscribePlayback: (() => void) | null = null
let unsubscribeLyrics: (() => void) | null = null
// What the guests were last sent, so lyrics go out once per change rather
// than with every snapshot.
let sentLyricsKey: string | null = null
let lyricsSongId: string | null = null
let artistBackdrops: { artist: string; urls: string[] } | null = null

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate('stores/party.ts holds timers that cannot be safely hot-reloaded')
  })
}

/** Where each request sits in the queue right now, or -1 once it is gone. */
function queuePosition(queue: Song[], song: Song): number {
  const raw = toRaw(song)
  return queue.findIndex((t) => toRaw(t) === raw)
}

/** Where a new wish goes: round-robin across guests, inside the block of
 * wishes right after the current song. A guest's n-th open wish belongs to
 * round n, and a new one is placed after the last open wish of the same or
 * an earlier round - so A, A, A, then B queues as A, B, A, A. */
export function wishInsertIndex(
  pending: { guestId: string; position: number }[],
  guestId: string,
  currentIndex: number,
): number {
  const sorted = [...pending].sort((a, b) => a.position - b.position)
  const seen = new Map<string, number>()
  const myRound = sorted.filter((p) => p.guestId === guestId).length
  let after = currentIndex
  for (const p of sorted) {
    const round = seen.get(p.guestId) ?? 0
    seen.set(p.guestId, round + 1)
    if (round <= myRound) after = p.position
  }
  return after + 1
}

export const usePartyStore = defineStore('party', {
  state: (): PartyState => ({
    enabled: false,
    hostedHere: false,
    inviteToken: null,
    expiresAt: null,
    lanIp: '',
    port: 0,
    guests: [],
    requests: [],
    settings: loadSettings(),
  }),

  getters: {
    inviteUrl(state): string | null {
      if (!state.inviteToken) return null
      // The web build is reached under the address the host has open,
      // reverse proxy included; the desktop app only on this machine's LAN.
      const base = window.api ? `http://${state.lanIp}:${state.port}` : window.location.origin
      return `${base}/party/#t=${state.inviteToken}`
    },

    /** Requests still ahead in the queue, or playing right now. */
    activeRequests(state): (PartyRequest & { position: number })[] {
      const playback = usePlaybackStore()
      return state.requests
        .map((r) => ({ ...r, position: queuePosition(playback.queue, r.song) }))
        .filter((r) => r.position >= 0 && r.position >= playback.currentIndex)
    },

    /** Queue position -> request, for the queue rows to look up. */
    requestsByPosition(): Map<number, PartyRequest> {
      return new Map(this.activeRequests.map((r) => [r.position, r]))
    },

    connectedGuests(state): number {
      return state.guests.filter((g) => g.connected).length
    },
  },

  actions: {
    saveSettings(patch: Partial<PartySettings>): void {
      this.settings = { ...this.settings, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
      } catch {
        // Settings still apply for this session.
      }
      if (this.enabled) {
        void updatePartySettings({
          max_pending_per_guest: this.settings.maxPendingPerGuest,
          skip_ratio: this.settings.skipRatio,
        })
          .then((status) => this.applyStatus(status))
          .catch(() => {})
      }
    },

    applyStatus(status: PartyStatus): void {
      this.enabled = status.enabled
      this.expiresAt = status.expires_at
      this.lanIp = status.lan_ip
      this.port = status.port
      this.guests = status.guests
      if (!status.enabled) this.stopped()
    },

    async enable(): Promise<void> {
      const invite = await enableParty({
        duration_hours: this.settings.durationHours,
        max_pending_per_guest: this.settings.maxPendingPerGuest,
        skip_ratio: this.settings.skipRatio,
      })
      this.inviteToken = invite.token
      this.requests = []
      this.applyStatus(invite)
      this.started()
    },

    async rotate(): Promise<void> {
      const invite = await rotatePartyLink()
      this.inviteToken = invite.token
      this.applyStatus(invite)
    },

    async disable(): Promise<void> {
      try {
        await disableParty()
      } finally {
        this.enabled = false
        this.stopped()
      }
    },

    async kick(guestId: string): Promise<void> {
      this.applyStatus(await kickPartyGuest(guestId))
    },

    /** App start: a party can outlive a reload of this window, since
     * connect keeps running. The link itself can't be recovered (see
     * inviteToken), only renewed. The desktop app is the only window there
     * is; a browser tab only resumes a party it was hosting itself. */
    async refreshStatus(): Promise<void> {
      try {
        this.applyStatus(await getPartyStatus())
      } catch {
        return
      }
      if (this.enabled && (window.api || wasHost())) this.started()
    },

    /** Makes this window the one answering guests (see hostedHere). */
    takeOver(): void {
      if (this.enabled) this.started()
    },

    started(): void {
      this.hostedHere = true
      markHost(true)
      // The relay is how guests' wishes reach this window, and its
      // keepalive is what keeps the party alive on connect's side.
      useRemoteControlStore().startRelay()
      if (!statusTimer) {
        statusTimer = setInterval(() => {
          void getPartyStatus()
            .then((status) => this.applyStatus(status))
            .catch(() => {})
        }, STATUS_POLL_MS)
      }
      if (!unsubscribePlayback) {
        unsubscribePlayback = usePlaybackStore().$subscribe(
          () => {
            this.prune()
            this.followSong()
          },
          { detached: true },
        )
        this.followSong()
      }
      if (!unsubscribeLyrics) {
        unsubscribeLyrics = useLyricsStore().$subscribe(() => this.shareLyrics(), {
          detached: true,
        })
      }
    },

    /** Guests read along whether or not this window shows the lyrics, so
     * they are looked up for every song while a party runs - the same
     * lookup Now Playing makes, sharing its caches. */
    followSong(): void {
      const song = usePlaybackStore().currentSong
      if (!song || song.id === lyricsSongId) return
      lyricsSongId = song.id
      void useLyricsStore()
        .ensureLoaded(song)
        .catch(() => {})
      // Same for the artist's background: picked once per artist and
      // session (services/connect/fanart.ts), so guests get the one this
      // window shows, or will show once Now Playing opens.
      if (song.artist && useFanartStore().enabled) {
        const artist = song.artist
        void getArtistArt(artist)
          .then((art) => {
            // Every background, so guests can step through them on their
            // own as the app's cycle button does.
            artistBackdrops = {
              artist,
              urls: (art?.backgrounds ?? [])
                .map((url) => fanartSource(url))
                .filter((url): url is string => Boolean(url)),
            }
            useRemoteControlStore().refreshSnapshot()
          })
          .catch(() => {})
      }
    },

    /** The lyrics as this window has them - its chosen match and sync
     * offset included - for connect to hand to guests (core/party.py). */
    shareLyrics(): void {
      const key = this.lyricsKey()
      if (!key || key === sentLyricsKey) return
      const lyrics = useLyricsStore()
      sentLyricsKey = key
      void pushPartyLyrics({
        song_id: lyrics.songId!,
        synced: lyrics.synced,
        offset: lyrics.offset,
        lines: lyrics.lines.map((line) => ({ time: line.time, text: line.text })),
      })
        // Only now, so a guest told about new lyrics finds them there.
        .then(() => useRemoteControlStore().refreshSnapshot())
        .catch(() => {
          sentLyricsKey = null
        })
    },

    /** Changes whenever the lyrics guests should see do; null while there
     * are none for the playing song. */
    lyricsKey(): string | null {
      const lyrics = useLyricsStore()
      const song = usePlaybackStore().currentSong
      if (!song || lyrics.songId !== song.id || lyrics.loading || !lyrics.lines.length) {
        return null
      }
      return `${lyrics.songId}:${lyrics.source ?? ''}:${lyrics.remoteId ?? ''}:${lyrics.offset}:${lyrics.lines.length}`
    },

    /** The Fanart.tv background this window shows for the playing artist,
     * if Fanart.tv is on. */
    backdropSource(): string | null {
      const song = usePlaybackStore().currentSong
      if (!song?.artist || !useFanartStore().enabled) return null
      return shownBackgroundSource(song.artist)
    },

    /** All of the playing artist's backgrounds, for guests to step through. */
    backdropSources(): string[] {
      const song = usePlaybackStore().currentSong
      if (!song?.artist || !useFanartStore().enabled) return []
      return artistBackdrops?.artist === song.artist ? artistBackdrops.urls : []
    },

    stopped(): void {
      this.hostedHere = false
      markHost(false)
      this.inviteToken = null
      this.guests = []
      this.requests = []
      this.expiresAt = null
      if (statusTimer) clearInterval(statusTimer)
      statusTimer = null
      unsubscribePlayback?.()
      unsubscribePlayback = null
      unsubscribeLyrics?.()
      unsubscribeLyrics = null
      sentLyricsKey = null
      lyricsSongId = null
      artistBackdrops = null
      useRemoteControlStore().stopRelayUnlessNeeded()
    },

    /** Drops requests that have been played or that the host removed. */
    prune(): void {
      const active = new Set(this.activeRequests.map((r) => r.id))
      if (active.size !== this.requests.length) {
        this.requests = this.requests.filter((r) => active.has(r.id))
      }
    },

    /** A guest's wish, relayed from connect (routes/party.py). */
    wish(song: Song, guestId: string, guestName: string, maxPending: number): void {
      const playback = usePlaybackStore()
      // A station has no queue a wish would play from.
      if (playback.radioStation) throw new PartyRefusal('radio')
      const pending = this.activeRequests.filter((r) => r.position > playback.currentIndex)
      if (pending.filter((r) => r.guestId === guestId).length >= maxPending) {
        throw new PartyRefusal('limit')
      }
      if (pending.some((r) => r.song.id === song.id)) throw new PartyRefusal('duplicate')

      const index =
        playback.currentIndex < 0
          ? playback.queue.length
          : wishInsertIndex(pending, guestId, playback.currentIndex)
      // What went in, not `song`: insertAt() hands back a copy when that
      // very object is queued already, and the request has to point at its
      // own entry.
      const [inserted] = playback.insertAt(index, [song])
      if (!inserted) return
      this.requests.push({
        id: crypto.randomUUID(),
        song: inserted,
        guestId,
        guestName,
        requestedAt: Date.now(),
      })
    },

    withdraw(requestId: string, guestId: string): void {
      const playback = usePlaybackStore()
      const request = this.activeRequests.find((r) => r.id === requestId)
      if (!request || request.position <= playback.currentIndex) {
        throw new PartyRefusal('not-found')
      }
      if (request.guestId !== guestId) throw new PartyRefusal('forbidden')
      playback.removeFromQueue(request.position)
      this.requests = this.requests.filter((r) => r.id !== requestId)
    },

    /** Who wished for the song at this queue position, if anyone. */
    requestAt(position: number): PartyRequest | null {
      return this.requestsByPosition.get(position) ?? null
    },

    /** For the snapshot connect filters for guests (core/party.py). */
    snapshotRequests(): Record<string, { id: string; guest_id: string; guest_name: string }> {
      const result: Record<string, { id: string; guest_id: string; guest_name: string }> = {}
      for (const r of this.activeRequests) {
        result[String(r.position)] = { id: r.id, guest_id: r.guestId, guest_name: r.guestName }
      }
      return result
    },
  },
})
