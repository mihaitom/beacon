import { backoffRemainingMs } from './pollGate'

const INITIAL_RETRY_MS = 2000
const MAX_RETRY_MS = 30000

interface ReconnectingEventSourceHandlers {
  onMessage: (event: MessageEvent) => void
  onOpen?: () => void
  onError?: () => void
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
 */
export class ReconnectingEventSource {
  private source: EventSource | null = null
  private retryDelay = INITIAL_RETRY_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(
    private readonly url: string,
    private readonly handlers: ReconnectingEventSourceHandlers,
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
    this.source?.close()
    this.source = null
  }

  private open(): void {
    const source = new EventSource(this.url)
    this.source = source
    source.onopen = () => {
      this.retryDelay = INITIAL_RETRY_MS
      this.handlers.onOpen?.()
    }
    source.onmessage = this.handlers.onMessage
    source.onerror = () => {
      source.close()
      this.source = null
      this.handlers.onError?.()
      this.scheduleReconnect()
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
