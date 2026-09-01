import type { VisualizerFrame } from './types'
import { ReconnectingEventSource } from './reconnectingEventSource'

/**
 * Wraps GET /visualizer (via ReconnectingEventSource — see that file for why
 * a plain EventSource isn't enough) — real-time frequency-band frames for
 * AudioVisualizer.vue's 'cast' mode, produced by
 * connect/core/audio_analysis.py. Only ever emits while casting to a
 * Sonos/DLNA/Chromecast target; the connection sits idle (heartbeats only,
 * no onFrame calls) the rest of the time. Mirrors ConnectEventSource
 * (services/connect/events.ts) — same auth-via-query-param reasoning
 * (EventSource can't send custom headers).
 */
export class VisualizerEventSource {
  private source: ReconnectingEventSource | null = null

  onFrame: ((frame: VisualizerFrame) => void) | null = null

  constructor(
    private readonly connectUrl: string,
    private readonly connectToken: string,
    private readonly sessionId: string,
  ) {}

  start(): void {
    if (this.source) return
    const params = new URLSearchParams({ token: this.connectToken, session: this.sessionId })
    this.source = new ReconnectingEventSource(
      `${this.connectUrl}/visualizer?${params.toString()}`,
      {
        onMessage: (event) => {
          try {
            const frame = JSON.parse(event.data) as VisualizerFrame
            this.onFrame?.(frame)
          } catch {
            // Heartbeat/idle comments never reach onmessage — this only
            // catches a genuinely malformed data payload.
          }
        },
      },
    )
    this.source.start()
  }

  stop(): void {
    this.source?.stop()
    this.source = null
  }
}
