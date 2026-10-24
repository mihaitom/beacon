<template>
  <div v-if="active && info" class="stream-debug-overlay">
    <button
      type="button"
      class="stream-debug-overlay__action"
      :aria-expanded="showLegend"
      :title="showLegend ? 'Hide what these mean' : 'What do these mean?'"
      @click="showLegend = !showLegend"
    >
      {{ showLegend ? '×' : '?' }}
    </button>
    <!-- Copied as one timestamped snapshot for the same reason as the
     - visualizer overlay's: the numbers change every two seconds, and a
     - pasted reading is lined up against connect's log by its time. -->
    <button
      type="button"
      class="stream-debug-overlay__action"
      :title="copied ? 'Copied' : 'Copy this reading'"
      @click="copyReading"
    >
      {{ copied ? '✓' : '⧉' }}
    </button>
    <div
      v-for="line in lines"
      :key="line.label"
      :class="line.tone ? `stream-debug-overlay__line--${line.tone}` : null"
    >
      {{ line.label }}: {{ line.value }}
    </div>

    <dl v-if="showLegend" class="stream-debug-overlay__legend">
      <dt>Stream</dt>
      <dd>
        The speaker and what kind it is — for a Sonos its model number and, for an older one, how it
        gets a song (Settings → Advanced).
      </dd>
      <dt>Sent</dt>
      <dd>
        What the speaker has taken from the newest connection, and how far into the song that
        reaches. <em>done</em> = the whole song went out.
      </dd>
      <dt>Read</dt>
      <dd>
        How fast it is taking more, and when it last did. Red: the connection is open but it has
        stopped reading — the speaker will play out what it has and stop there. An AirPlay speaker
        is sent the song by connect itself, so here this is connect's own sender.
      </dd>
      <dt>Device</dt>
      <dd>
        Where the speaker last said it was, and its last reported state. AirPlay reports neither:
        its position is what has gone out, less the fixed delay AirPlay plays behind by.
      </dd>
      <dt>Ahead</dt>
      <dd>Seconds of song it has beyond that: its buffer. Red under 5s.</dd>
      <dt>Asked</dt>
      <dd>
        What it asked for lately. A <em>HEAD</em> comes shortly before it runs out; a
        <em>range</em> is it fetching a part of a file; <em>→ 204</em> or <em>→ 416</em> is a
        request turned away.
      </dd>
    </dl>
  </div>
</template>

<script lang="ts">
import { getLogLevel } from '@/services/connect/logLevel'
import {
  getStreamDiagnostics,
  type StreamConnectionInfo,
  type StreamDiagnostics,
} from '@/services/connect/streamDiagnostics'
import { usePlaybackStore } from '@/stores/playback'

// How often connect is asked - often enough to watch a read rate and a
// buffer move, and the same cadence ffmpeg reports its progress at.
const POLL_MS = 2000
// A speaker that has taken nothing for this long while its connection is
// open has stopped reading; one that is merely full reads a block every few
// seconds as it plays (measured on a Play:3, #56).
const STALLED_SECONDS = 10

interface Line {
  label: string
  value: string
  tone?: 'bad' | 'warn' | 'good'
}

/**
 * How the cast stream reaches its speaker right now (#56): what it was sent,
 * whether it is still reading, its buffer, and what it asked for. Only while
 * casting with connect's log level at DEBUG or TRACE, like the visualizer
 * overlay beside it, and like that one not translated: a diagnostic for
 * whoever is chasing a speaker that stops, not user-facing copy.
 */
export default {
  name: 'CastStreamDebugOverlay',
  data() {
    return {
      enabled: false,
      info: null as StreamDiagnostics | null,
      pollTimer: undefined as ReturnType<typeof setInterval> | undefined,
      // The previous reading of the newest connection, for its read rate.
      sample: null as { key: number; bytes: number; at: number } | null,
      readRate: null as number | null,
      showLegend: false,
      copied: false,
      copiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    active(): boolean {
      return this.enabled && usePlaybackStore().isCasting
    },
    connection(): StreamConnectionInfo | null {
      const connections = this.info?.connections ?? []
      return connections.find((c) => c.current) ?? connections[0] ?? null
    },
    lines(): Line[] {
      const info = this.info
      if (!info) return []
      const lines: Line[] = []
      const target = info.targets[0]
      const conn = this.connection
      const name = target ? target.name : 'nothing'
      const kind = conn?.model ?? target?.type
      lines.push({ label: 'Stream', value: `${name}${kind ? ` · ${kind}` : ''}` })
      if (conn) {
        const reach = conn.audio_end !== null ? ` · to ${seconds(conn.audio_end)}` : ''
        const state = conn.open
          ? 'open'
          : conn.outcome === 'source finished'
            ? 'done'
            : conn.outcome
        lines.push({ label: 'Sent', value: `${mib(conn.bytes)}${reach} · ${state}` })
        const stalled = conn.open && conn.last_read > STALLED_SECONDS
        const rate = this.readRate !== null ? `${Math.round(this.readRate / 1024)} KiB/s · ` : ''
        lines.push({
          label: 'Read',
          value: `${rate}last ${conn.last_read.toFixed(1)}s ago${stalled ? ' · STALLED' : ''}`,
          tone: stalled ? 'bad' : undefined,
        })
      }
      const position = info.device
        ? `${seconds(info.device.position)} (${info.device.age.toFixed(0)}s ago)`
        : '—'
      // An AirPlay speaker reports no state of its own, so there is none
      // to show rather than an unknown one.
      const state = target?.state ? ` · ${target.state}` : ''
      lines.push({ label: 'Device', value: `${position}${state}` })
      if (info.ahead !== null) {
        lines.push({
          label: 'Ahead',
          value: seconds(info.ahead),
          tone: info.ahead < 5 ? 'bad' : info.ahead < 20 ? 'warn' : 'good',
        })
      }
      if (info.track_end !== null) {
        const now = info.position !== null ? ` · now ${seconds(info.position)}` : ''
        lines.push({ label: 'Ends at', value: `${seconds(info.track_end)}${now}` })
      }
      if (info.requests.length) {
        const asked = info.requests.slice(0, 3).map((r) => {
          const range = r.range ? ` ${r.range}` : ''
          const icy = r.icy ? ` icy-metadata ${r.icy}` : ''
          const answer = r.answer ? ` → ${r.answer}` : ''
          return `${r.method}${range}${icy}${answer} ${r.ago.toFixed(0)}s ago`
        })
        lines.push({ label: 'Asked', value: asked.join(' · ') })
      }
      if (target?.problem && target.problem_age !== null) {
        lines.push({
          label: 'Problem',
          value: `${target.problem} ${target.problem_age.toFixed(0)}s ago`,
          tone: 'bad',
        })
      }
      return lines
    },
  },
  watch: {
    active: {
      immediate: true,
      handler(active: boolean) {
        if (active) this.startPolling()
        else this.stopPolling()
      },
    },
  },
  mounted() {
    // Best-effort, as the visualizer overlay does it: a failed call leaves
    // the overlay off, which is right for anyone not chasing anything.
    getLogLevel()
      .then(({ level }) => {
        this.enabled = level === 'DEBUG' || level === 'TRACE'
      })
      .catch(() => {})
  },
  beforeUnmount() {
    this.stopPolling()
    clearTimeout(this.copiedTimer)
  },
  methods: {
    startPolling(): void {
      this.stopPolling()
      void this.poll()
      this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
    },
    stopPolling(): void {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.info = null
      this.sample = null
      this.readRate = null
    },
    async poll(): Promise<void> {
      try {
        const info = await getStreamDiagnostics()
        if (!this.pollTimer) return // stopped while this was in flight
        this.info = info
        this.measureReadRate()
      } catch {
        // The next poll tries again; a missed reading is not worth a word.
      }
    },
    /** Bytes taken since the last reading of the same connection, which is
     * recognised by when it opened. */
    measureReadRate(): void {
      const conn = this.connection
      if (!conn) {
        this.sample = null
        this.readRate = null
        return
      }
      const at = Date.now() / 1000
      const key = Math.round(at - conn.age)
      if (this.sample && this.sample.key === key && at > this.sample.at) {
        this.readRate = (conn.bytes - this.sample.bytes) / (at - this.sample.at)
      } else {
        this.readRate = null
      }
      this.sample = { key, bytes: conn.bytes, at }
    },
    readingText(): string {
      const at = new Date().toLocaleTimeString()
      return [`Cast stream @ ${at}`, ...this.lines.map((l) => `${l.label}: ${l.value}`)].join('\n')
    },
    async copyReading(): Promise<void> {
      try {
        await navigator.clipboard.writeText(this.readingText())
        clearTimeout(this.copiedTimer)
        this.copied = true
        this.copiedTimer = setTimeout(() => {
          this.copied = false
        }, 2000)
      } catch (error) {
        console.error('[stream-debug] Failed to copy the reading:', error)
      }
    },
  },
}

function seconds(value: number): string {
  return `${value.toFixed(1)}s`
}

function mib(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MiB`
}
</script>

<style scoped>
/* The visualizer overlay's look, so the two read as one instrument where
 * they sit stacked in the same corner. */
.stream-debug-overlay {
  max-width: 380px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.92);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
}

.stream-debug-overlay__action {
  float: right;
  margin-left: 10px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  font: inherit;
  line-height: 16px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.stream-debug-overlay__action:hover {
  background: rgba(255, 255, 255, 0.22);
}

.stream-debug-overlay__line--good {
  color: rgba(140, 255, 170, 0.95);
}

.stream-debug-overlay__line--warn {
  color: rgba(255, 210, 130, 0.95);
}

.stream-debug-overlay__line--bad {
  color: rgba(255, 120, 120, 0.95);
  font-weight: 600;
}

.stream-debug-overlay__legend {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Roboto,
    sans-serif;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.75);
}

.stream-debug-overlay__legend dt {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}

.stream-debug-overlay__legend dd {
  margin: 0 0 6px;
}

.stream-debug-overlay__legend dd:last-child {
  margin-bottom: 0;
}

.stream-debug-overlay__legend em {
  font-style: normal;
  color: rgba(140, 255, 170, 0.95);
}
</style>
