/** The guest's own player for listening along: one live AAC stream from
 * connect (core/party_broadcast.py), played by a plain <audio> element.
 *
 * Built after the app's live-stream handling (services/audioEngine.ts's
 * playLive() with holdsConnection) rather than importing it - the guest
 * page carries none of the app's playback code. The same two rules apply:
 * a stall is first only reported, because connect keeps queueing on the
 * open connection what a dead spot on mobile data missed, and only a
 * connection quiet for LIVE_HOLD_SECONDS is given up and reconnected. */

import { LISTEN_URL, partyApi } from './api'

export type ListenState = 'off' | 'connecting' | 'playing' | 'buffering' | 'failed'

/** Whether this browser lets a page set an element's volume. iOS does not:
 * there `volume` stays 1 whatever is assigned, and only the hardware buttons
 * change it. */
export function volumeAdjustable(): boolean {
  try {
    const probe = new Audio()
    probe.volume = 0.5
    return probe.volume === 0.5
  } catch {
    return false
  }
}

// Same numbers as audioEngine.ts's live stream, for the same reasons.
const STALL_SECONDS = 4
const HOLD_SECONDS = 20
const RECONNECT_DELAYS_SECONDS = [1, 2, 4, 8, 15, 15]
const RETRY_INTERVAL_SECONDS = 30
const RECONNECT_WINDOW_SECONDS = 600
const WATCH_MS = 1000
// /listen/start answers null until connect has handed the connection its
// first audio, which is a moment after the element starts fetching.
const START_ATTEMPTS = 10
const START_RETRY_MS = 300

function connectionId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export class ListenAlongPlayer {
  private audio: HTMLAudioElement | null = null
  private conn: string | null = null
  /** Stream time this connection's audio begins at, and which stream. */
  private start: number | null = null
  epoch: string | null = null
  state: ListenState = 'off'
  private watchTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastTime = 0
  private lastProgressAt = 0
  private attempts = 0
  private dropStartedAt: number | null = null
  private volume = 1

  constructor(
    private readonly onChange: (state: ListenState) => void,
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  /** Starts listening. Has to be called straight from the guest's tap:
   * browsers only let sound start from inside one. */
  play(): void {
    this.attempts = 0
    this.dropStartedAt = null
    this.connect()
  }

  /** 0..1, kept for the elements of later connections too. */
  setVolume(volume: number): void {
    this.volume = volume
    if (this.audio) this.audio.volume = volume
  }

  stop(): void {
    this.clearTimers()
    this.release()
    this.setState('off')
  }

  /** The stream time being heard now, or null until it is known. */
  heardTime(): number | null {
    if (this.start === null || !this.audio) return null
    return this.start + this.audio.currentTime
  }

  /** Connect started a new stream (a new bitrate, a restart): this
   * connection's stream times belong to the old one. */
  followEpoch(epoch: string | null): void {
    if (this.state === 'off' || this.state === 'failed') return
    if (epoch && this.epoch && epoch !== this.epoch) this.connect()
  }

  private connect(): void {
    this.clearTimers()
    this.release()
    this.setState('connecting')
    this.conn = connectionId()
    this.audio ??= this.createAudio()
    const audio = this.audio
    audio.preload = 'none'
    audio.volume = this.volume
    audio.onplaying = () => this.onPlaying()
    audio.ontimeupdate = () => this.onProgress()
    audio.onerror = () => this.dropped()
    audio.onended = () => this.dropped()
    audio.src = `${LISTEN_URL}?c=${this.conn}`
    this.lastTime = 0
    this.lastProgressAt = Date.now()
    audio.play().catch((error: unknown) => {
      // Not allowed to start sound: only a new tap can fix that.
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.fail()
        return
      }
      this.dropped()
    })
    this.watchTimer = setInterval(() => this.watch(), WATCH_MS)
  }

  private onPlaying(): void {
    this.attempts = 0
    this.dropStartedAt = null
    this.setState('playing')
    if (this.start === null) void this.fetchStart(this.conn)
  }

  private onProgress(): void {
    const time = this.audio?.currentTime ?? 0
    if (time > this.lastTime) {
      this.lastTime = time
      this.lastProgressAt = Date.now()
      if (this.state === 'buffering') this.setState('playing')
    }
  }

  private async fetchStart(conn: string | null): Promise<void> {
    for (let attempt = 0; attempt < START_ATTEMPTS && conn === this.conn; attempt++) {
      try {
        const answer = await partyApi.listenStart(conn as string)
        if (conn !== this.conn) return
        this.epoch = answer.epoch
        if (answer.start !== null) {
          this.start = answer.start
          this.onChange(this.state)
          return
        }
      } catch {
        // Asked again below; a connection that is gone ends in dropped().
      }
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS))
    }
  }

  private watch(): void {
    if (!this.audio || this.audio.paused || this.reconnectTimer !== null) return
    this.onProgress()
    const stalledMs = Date.now() - this.lastProgressAt
    if (stalledMs < STALL_SECONDS * 1000) return
    if (stalledMs < HOLD_SECONDS * 1000) {
      if (this.state === 'playing') this.setState('buffering')
      return
    }
    this.dropped()
  }

  private dropped(): void {
    if (this.state === 'off' || this.state === 'failed' || this.reconnectTimer !== null) return
    this.clearTimers()
    this.release()
    const now = Date.now()
    this.dropStartedAt ??= now
    if (now - this.dropStartedAt >= RECONNECT_WINDOW_SECONDS * 1000) {
      this.fail()
      return
    }
    const delay = RECONNECT_DELAYS_SECONDS[this.attempts] ?? RETRY_INTERVAL_SECONDS
    this.attempts++
    this.setState('buffering')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay * 1000)
  }

  private fail(): void {
    this.clearTimers()
    this.release()
    this.setState('failed')
  }

  private release(): void {
    this.conn = null
    this.start = null
    this.epoch = null
    const audio = this.audio
    if (!audio) return
    audio.onplaying = audio.ontimeupdate = audio.onerror = audio.onended = null
    audio.pause()
    // Without this the element keeps the connection open after pause().
    audio.removeAttribute('src')
    audio.load()
  }

  private clearTimers(): void {
    if (this.watchTimer !== null) clearInterval(this.watchTimer)
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.watchTimer = null
    this.reconnectTimer = null
  }

  private setState(state: ListenState): void {
    this.state = state
    this.onChange(state)
  }
}
