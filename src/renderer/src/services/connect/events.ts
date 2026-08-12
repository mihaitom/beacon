import type { ConnectStatus } from './types'

/**
 * Wraps the native EventSource against GET /events. Auth travels as query
 * params — EventSource can't send custom headers (see connect/routes/
 * stream.py, require_token/get_session both accept ?token=/?session=).
 * Reconnection is handled by the browser's native EventSource (the server
 * sends `retry: 2000`), we just surface state changes upward.
 */
export class ConnectEventSource {
  private source: EventSource | null = null

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
    this.source = new EventSource(`${this.connectUrl}/events?${params.toString()}`)
    this.source.onopen = () => this.onConnectionChange?.(true)
    this.source.onerror = () => this.onConnectionChange?.(false)
    this.source.onmessage = (event) => {
      try {
        const status = JSON.parse(event.data) as ConnectStatus
        this.onStatus?.(status)
      } catch {
        // Heartbeat comments (": heartbeat") never reach onmessage — this
        // only catches a genuinely malformed data payload.
      }
    }
  }

  stop(): void {
    this.source?.close()
    this.source = null
  }
}
