/** Mirrors services/connect/events.ts's ConnectEventSource, but subscribes to
 * GET /remote/agent-events instead of /events — this is the renderer's single
 * long-lived connection to connect's Remote Control relay, carrying both
 * phone-issued playback commands and data queries (see routes/remote.py).
 * Auth travels as a query param — EventSource can't send custom headers,
 * same reasoning as ConnectEventSource (core/auth.py's require_token already
 * has a ?token= fallback for exactly this). */

export interface RemoteCommandMessage {
  kind: 'command'
  request_id: string
  type: string
  payload: Record<string, unknown>
}

export interface RemoteQueryMessage {
  kind: 'query'
  request_id: string
  type: string
  payload: Record<string, unknown>
}

export class RemoteAgentEventSource {
  private source: EventSource | null = null

  onCommand: ((message: RemoteCommandMessage) => void) | null = null
  onQuery: ((message: RemoteQueryMessage) => void) | null = null

  constructor(
    private readonly connectUrl: string,
    private readonly connectToken: string,
  ) {}

  start(): void {
    if (this.source) return
    const params = new URLSearchParams({ token: this.connectToken })
    this.source = new EventSource(`${this.connectUrl}/remote/agent-events?${params.toString()}`)
    this.source.onmessage = (event) => {
      let message: RemoteCommandMessage | RemoteQueryMessage
      try {
        message = JSON.parse(event.data)
      } catch {
        return // heartbeat comments never reach onmessage; ignore anything else malformed
      }
      if (message.kind === 'command') this.onCommand?.(message)
      else if (message.kind === 'query') this.onQuery?.(message)
    }
  }

  stop(): void {
    this.source?.close()
    this.source = null
  }
}
