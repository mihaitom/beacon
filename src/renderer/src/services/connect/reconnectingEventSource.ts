import { backoffRemainingMs } from './pollGate'

const INITIAL_RETRY_MS = 2000
const MAX_RETRY_MS = 30000

interface ReconnectingEventSourceHandlers {
  onMessage: (event: MessageEvent) => void
  onOpen?: () => void
  onError?: () => void
}

/** A server that sends `event` whenever it has nothing else to say. Once
 * one has arrived on a connection, that connection going silent for
 * `staleAfterMs` counts as dead and is replaced. */
export interface HeartbeatOptions {
  event: string
  staleAfterMs: number
}

/**
 * A native EventSource reconnects on every drop using the server's `retry:`
 * hint verbatim, forever, with no backoff - fine on a stable LAN, but on a
 * flaky connection (mobile data, a household WiFi hiccup) that's a request
 * every 2s indefinitely. Enough of those from one source, especially if any
 * come back as an error status, is exactly what trips a reverse proxy's
 * probe/flood detection (crowdsec's http-probing scenario did this to a real
 * user's own external IP - see git history for the incident).
 *
 * This wraps EventSource with an app-level reconnect instead: exponential
 * backoff (capped, with jitter so multiple tabs/devices don't retry in
 * lockstep after a shared network blip), reset on a successful open, and no
 * retries at all while the browser reports itself offline - resuming
 * immediately on the `online` event instead of waiting out the backoff.
 *
 * With `heartbeat`, it also notices a connection that died without an
 * error - a half-open TCP connection after a network hiccup, where the
 * EventSource stays "open" and simply never hears anything again. Nothing
 * else would: the app kept showing the song it last heard of, its position
 * counting up to the end and stopping there, while a cast went on to the
 * next song. Only once the server has shown it sends heartbeats, so an
 * older server that sends comments instead is left as it was.
 */
export class ReconnectingEventSource {
  private source: EventSource | null = null
  private retryDelay = INITIAL_RETRY_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  // When this connection last delivered anything, and whether its server
  // has sent a heartbeat yet - see HeartbeatOptions.
  private lastHeard = 0
  private heartbeats = false

  constructor(
    private readonly url: string,
    private readonly handlers: ReconnectingEventSourceHandlers,
    private readonly heartbeat?: HeartbeatOptions,
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    window.removeEventListener('online', this.handleOnline)
    this.clearStaleTimer()
    this.source?.close()
    this.source = null
  }

  private open(): void {
    const source = new EventSource(this.url)
    this.source = source
    this.heartbeats = false
    this.lastHeard = Date.now()
    source.onopen = () => {
      this.retryDelay = INITIAL_RETRY_MS
      this.heard()
      this.handlers.onOpen?.()
    }
    source.onmessage = (event) => {
      this.heard()
      this.handlers.onMessage(event)
    }
    if (this.heartbeat) {
      source.addEventListener(this.heartbeat.event, () => {
        this.heartbeats = true
        this.heard()
      })
    }
    source.onerror = () => this.drop(source)
  }

  /** Gives up on `source` and schedules the next one. */
  private drop(source: EventSource): void {
    if (this.source !== source) return
    this.clearStaleTimer()
    source.close()
    this.source = null
    this.handlers.onError?.()
    this.scheduleReconnect()
  }

  private heard(): void {
    this.lastHeard = Date.now()
    if (this.heartbeat && this.heartbeats && !this.staleTimer) this.armStaleTimer()
  }

  /** Checks against the time last heard rather than trusting the timer
   * alone: a timer in a hidden window or across a suspend can fire late,
   * and what counts is how long nothing arrived. */
  private armStaleTimer(): void {
    const staleAfterMs = this.heartbeat!.staleAfterMs
    const left = this.lastHeard + staleAfterMs - Date.now()
    this.staleTimer = setTimeout(
      () => {
        this.staleTimer = null
        const source = this.source
        if (!source) return
        if (Date.now() - this.lastHeard < staleAfterMs) {
          this.armStaleTimer()
          return
        }
        console.warn(
          `[events] Nothing from ${this.url.split('?')[0]} for ${Math.round(staleAfterMs / 1000)}s — reconnecting`,
        )
        // Straight back rather than on the backoff: the server was fine a
        // moment ago, it is the line that went.
        this.retryDelay = INITIAL_RETRY_MS
        this.drop(source)
      },
      Math.max(left, 0),
    )
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    if (!navigator.onLine) {
      window.addEventListener('online', this.handleOnline, { once: true })
      return
    }
    const jitter = 0.8 + Math.random() * 0.4
    // An EventSource that keeps being refused is the one connection in the
    // app that reconnects on its own schedule regardless of what anything
    // else has learned, so it is also the one most able to keep a ban
    // alive single-handedly. While the app is backing off (see
    // pollGate.ts), wait that out first — this is a delay on top of the
    // ordinary backoff, never a shortening of it.
    const delay = Math.max(this.retryDelay * jitter, backoffRemainingMs())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
  }

  private handleOnline = (): void => {
    this.retryDelay = INITIAL_RETRY_MS
    this.open()
  }
}
