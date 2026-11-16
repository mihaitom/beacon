import type { ConnectStatus } from './types'
import { ReconnectingEventSource, type HeartbeatOptions } from './reconnectingEventSource'

/** /events sends status or a heartbeat every 2s (connect/routes/stream.py's
 * status_events), so five missed in a row is a dead line, not a quiet
 * session. */
export const EVENTS_HEARTBEAT: HeartbeatOptions = { event: 'heartbeat', staleAfterMs: 10000 }

/**
 * Wraps GET /events (via ReconnectingEventSource — see that file for why a
 * plain EventSource isn't enough). Auth travels as query params —
 * EventSource can't send custom headers (see connect/routes/stream.py,
 * require_token/get_session both accept ?token=/?session=).
 */
export class ConnectEventSource {
  private source: ReconnectingEventSource | null = null

  onStatus: ((status: ConnectStatus) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(
    private readonly connectUrl: string,
    private readonly connectToken: string,
    private readonly sessionId: string,
  ) {}

  start(): void {
    if (this.source) return
    const params = new URLSearchParams({ token: this.connectToken, session: this.sessionId })
    this.source = new ReconnectingEventSource(
      `${this.connectUrl}/events?${params.toString()}`,
      {
        onOpen: () => this.onConnectionChange?.(true),
        onError: () => this.onConnectionChange?.(false),
        onMessage: (event) => {
          try {
            const status = JSON.parse(event.data) as ConnectStatus
            this.onStatus?.(status)
          } catch {
            // Heartbeats are a named event and never reach onmessage — this
            // only catches a genuinely malformed data payload.
          }
        },
      },
      EVENTS_HEARTBEAT,
    )
    this.source.start()
  }

  stop(): void {
    this.source?.stop()
    this.source = null
  }
}
