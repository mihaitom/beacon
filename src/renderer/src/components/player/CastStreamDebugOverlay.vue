<template>
  <DebugPanel
    v-if="active && info"
    class="stream-debug-overlay"
    title="Cast stream"
    :meta="meta"
    :copy-text="readingText"
  >
    <section
      v-for="speaker in speakers"
      :key="speaker.name"
      class="stream-debug-overlay__speaker"
      :class="`stream-debug-overlay__speaker--${speaker.tone}`"
    >
      <div class="stream-debug-overlay__speaker-head">
        <span class="stream-debug-overlay__dot" aria-hidden="true" />
        <span class="stream-debug-overlay__name">{{ speaker.name }}</span>
        <span class="stream-debug-overlay__kind">{{ speaker.kind }}</span>
        <span v-if="speaker.state" class="stream-debug-overlay__state">{{ speaker.state }}</span>
      </div>
      <DebugReadings :rows="speaker.rows" />
    </section>

    <template #legend>
      <dt>Speakers</dt>
      <dd>
        One block per speaker cast to, each with its own connection: the dot is red when it has a
        problem or stopped reading, amber when its buffer runs low. A block marked
        <code>not a target</code> is an address that asked for the stream without being one - a
        speaker playing on from its own app, say.
      </dd>
      <dt>Sent</dt>
      <dd>
        What the speaker has taken from its newest connection, and how far into the song that
        reaches. <code>done</code> = the whole song went out.
      </dd>
      <dt>Read</dt>
      <dd>
        How fast it is taking more, and when it last did. Red: the connection is open but it has
        stopped reading - the speaker will play out what it has and stop there. An AirPlay speaker
        is sent the song by connect itself, so here this is connect's own sender.
      </dd>
      <dt>Via</dt>
      <dd>A Sonos grouped with another plays through that one and opens no connection itself.</dd>
      <dt>Device</dt>
      <dd>
        Where the speaker last said it was. Only one speaker is asked, so the others show none.
        AirPlay reports no position of its own: its is what has gone out, less the fixed delay
        AirPlay plays behind by.
      </dd>
      <dt>Ahead</dt>
      <dd>Seconds of song it has beyond that: its buffer. Red under 5s.</dd>
      <dt>Asked</dt>
      <dd>
        What it asked for lately. A <code>HEAD</code> comes shortly before it runs out; a
        <code>range</code> is it fetching a part of a file; <code>→ 204</code> or
        <code>→ 416</code> is a request turned away.
      </dd>
    </template>
  </DebugPanel>
</template>

<script lang="ts">
import { getLogLevel } from '@/services/connect/logLevel'
import {
  getStreamDiagnostics,
  type StreamDiagnostics,
  type StreamTargetInfo,
} from '@/services/connect/streamDiagnostics'
import { usePlaybackStore } from '@/stores/playback'
import DebugPanel from './DebugPanel.vue'
import DebugReadings, { readingsText, type DebugReading } from './DebugReadings.vue'

// How often connect is asked - often enough to watch a read rate and a
// buffer move, and the same cadence ffmpeg reports its progress at.
const POLL_MS = 2000
// A speaker that has taken nothing for this long while its connection is
// open has stopped reading; one that is merely full reads a block every few
// seconds as it plays (measured on a Play:3, #56).
const STALLED_SECONDS = 10
const AHEAD_BAD_SECONDS = 5
const AHEAD_LOW_SECONDS = 20

interface Speaker {
  name: string
  kind: string
  state: string | null
  tone: 'good' | 'warn' | 'bad' | 'idle'
  rows: DebugReading[]
}

/**
 * How the cast stream reaches each speaker right now (#56): what it was
 * sent, whether it is still reading, its buffer, and what it asked for -
 * one block per speaker, since cast to several at once every one of them
 * fetches on its own and one can stall while the rest play on. Only while
 * casting with connect's log level at DEBUG or TRACE.
 */
export default {
  name: 'CastStreamDebugOverlay',
  components: { DebugPanel, DebugReadings },
  data() {
    return {
      enabled: false,
      info: null as StreamDiagnostics | null,
      pollTimer: undefined as ReturnType<typeof setInterval> | undefined,
      // Each speaker's previous reading of its connection, for its read rate.
      samples: {} as Record<string, { key: number; bytes: number; at: number }>,
      readRates: {} as Record<string, number>,
    }
  },
  computed: {
    active(): boolean {
      return this.enabled && usePlaybackStore().isCasting
    },
    meta(): string | null {
      const info = this.info
      if (!info || info.position === null) return null
      const end = info.track_end !== null ? ` / ${seconds(info.track_end)}` : ''
      return `${seconds(info.position)}${end}`
    },
    speakers(): Speaker[] {
      return (this.info?.targets ?? []).map((target) => this.describe(target))
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
  },
  methods: {
    describe(target: StreamTargetInfo): Speaker {
      const rows: DebugReading[] = []
      const conn = target.connection
      let stalled = false
      if (target.follows) {
        rows.push({ label: 'Via', value: target.follows })
      }
      if (conn) {
        const reach = conn.audio_end !== null ? ` · to ${seconds(conn.audio_end)}` : ''
        const state = conn.open
          ? 'open'
          : conn.outcome === 'source finished'
            ? 'done'
            : conn.outcome
        rows.push({ label: 'Sent', value: `${mib(conn.bytes)}${reach} · ${state}` })
        stalled = conn.open && conn.last_read > STALLED_SECONDS
        const rate = this.readRates[target.name]
        const rateText = rate !== undefined ? `${Math.round(rate / 1024)} KiB/s · ` : ''
        rows.push({
          label: 'Read',
          value: `${rateText}last ${conn.last_read.toFixed(1)}s ago${stalled ? ' · STALLED' : ''}`,
          tone: stalled ? 'bad' : undefined,
        })
      }
      if (target.device) {
        const { position, age } = target.device
        rows.push({ label: 'Device', value: `${seconds(position)} (${age.toFixed(0)}s ago)` })
      }
      if (target.ahead !== null) {
        rows.push({
          label: 'Ahead',
          value: seconds(target.ahead),
          tone: aheadTone(target.ahead),
        })
      }
      if (target.requests.length) {
        const asked = target.requests.map((r) => {
          const range = r.range ? ` ${r.range}` : ''
          const icy = r.icy ? ` icy-metadata ${r.icy}` : ''
          const answer = r.answer ? ` → ${r.answer}` : ''
          return `${r.method}${range}${icy}${answer} ${r.ago.toFixed(0)}s ago`
        })
        rows.push({ label: 'Asked', value: asked.join(' · ') })
      }
      if (target.problem && target.problem_age !== null) {
        rows.push({
          label: 'Problem',
          value: `${target.problem} ${target.problem_age.toFixed(0)}s ago`,
          tone: 'bad',
        })
      }

      const kind = target.type === null ? 'not a target' : (conn?.model ?? target.type)
      const ahead = target.ahead !== null ? aheadTone(target.ahead) : null
      let tone: Speaker['tone'] = 'idle'
      if (target.problem || stalled || ahead === 'bad') tone = 'bad'
      else if (ahead === 'warn' || target.type === null) tone = 'warn'
      else if (conn?.open || target.follows) tone = 'good'
      // An AirPlay speaker reports no state of its own, so there is none
      // to show rather than an unknown one.
      return { name: target.name, kind, state: target.state, tone, rows }
    },
    startPolling(): void {
      this.stopPolling()
      void this.poll()
      this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
    },
    stopPolling(): void {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.info = null
      this.samples = {}
      this.readRates = {}
    },
    async poll(): Promise<void> {
      try {
        const info = await getStreamDiagnostics()
        if (!this.pollTimer) return // stopped while this was in flight
        this.info = info
        this.measureReadRates()
      } catch {
        // The next poll tries again; a missed reading is not worth a word.
      }
    },
    /** Bytes each speaker took since its last reading of the same
     * connection, which is recognised by when it opened. */
    measureReadRates(): void {
      const at = Date.now() / 1000
      const samples: typeof this.samples = {}
      const rates: typeof this.readRates = {}
      for (const target of this.info?.targets ?? []) {
        const conn = target.connection
        if (!conn) continue
        const key = Math.round(at - conn.age)
        const before = this.samples[target.name]
        if (before && before.key === key && at > before.at) {
          rates[target.name] = (conn.bytes - before.bytes) / (at - before.at)
        }
        samples[target.name] = { key, bytes: conn.bytes, at }
      }
      this.samples = samples
      this.readRates = rates
    },
    readingText(): string {
      const lines = this.meta ? [`Track: ${this.meta}`] : []
      for (const speaker of this.speakers) {
        const state = speaker.state ? ` · ${speaker.state}` : ''
        lines.push(`${speaker.name} (${speaker.kind}${state})`, readingsText(speaker.rows, '  '))
      }
      return lines.join('\n')
    },
  },
}

function aheadTone(ahead: number): DebugReading['tone'] {
  if (ahead < AHEAD_BAD_SECONDS) return 'bad'
  return ahead < AHEAD_LOW_SECONDS ? 'warn' : 'good'
}

function seconds(value: number): string {
  return `${value.toFixed(1)}s`
}

function mib(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MiB`
}
</script>

<style scoped>
.stream-debug-overlay__speaker + .stream-debug-overlay__speaker {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.stream-debug-overlay__speaker-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 12.5px;
}

/* The speaker's verdict at a glance, so with four of them the one in
 * trouble is found before any figure is read. */
.stream-debug-overlay__dot {
  flex: none;
  align-self: center;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
}

.stream-debug-overlay__speaker--good .stream-debug-overlay__dot {
  background: rgb(var(--v-theme-success));
}

.stream-debug-overlay__speaker--warn .stream-debug-overlay__dot {
  background: rgb(var(--v-theme-warning));
}

.stream-debug-overlay__speaker--bad .stream-debug-overlay__dot {
  background: rgb(var(--v-theme-error));
  box-shadow: 0 0 0 3px rgba(var(--v-theme-error), 0.25);
}

.stream-debug-overlay__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stream-debug-overlay__kind,
.stream-debug-overlay__state {
  flex: none;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

.stream-debug-overlay__state {
  margin-left: auto;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
}
</style>
