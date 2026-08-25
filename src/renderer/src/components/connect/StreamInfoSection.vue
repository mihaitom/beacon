<template>
  <!-- No icon/button of its own — rendered inline inside
   - ConnectDevicePicker.vue, which the user already opens to manage
   - devices, rather than adding another always-visible affordance
   - somewhere in the app's permanent chrome. Only meaningful while
   - actually casting — see this component's own v-if at its call site. -->
  <div class="stream-info-section">
    <div class="eyebrow-label stream-info-heading">{{ $t('connect.streamInfo.title') }}</div>
    <div class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.transcoding') }}</span>
      <span class="d-flex align-center" style="gap: 4px">
        <v-icon
          :icon="info.transcoding ? 'mdi-cog-sync-outline' : 'mdi-check-circle-outline'"
          :color="info.transcoding ? 'warning' : 'success'"
          size="small"
        />
        {{ info.transcoding ? targetLabel : $t('connect.streamInfo.no') }}
      </span>
    </div>
    <!-- Only under a transcoding one, and only for a reason this build
     - knows a wording for — a key from a newer backend renders as nothing
     - rather than as a raw "codec_unknown" leaking into the UI. -->
    <div v-if="reasonText" class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.reason') }}</span>
      <span class="stream-info-reason">{{ reasonText }}</span>
    </div>
    <div v-if="sourceLine" class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.source') }}</span>
      <span>{{ sourceLine }}</span>
    </div>
    <div class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.connection') }}</span>
      <span class="d-flex align-center" style="gap: 4px">
        <v-icon
          :icon="info.active_connections > 0 ? 'mdi-circle' : 'mdi-circle-outline'"
          :color="info.active_connections > 0 ? 'success' : undefined"
          size="10"
        />
        {{
          info.active_connections > 0
            ? $t('connect.streamInfo.connected')
            : $t('connect.streamInfo.idle')
        }}
      </span>
    </div>
    <!-- Only shown once there's something to actually flag — a healthy
     - 0.00s reading on every tick isn't information a casual glance needs,
     - only a real, currently-elevated stall is. See core/loop_health.py's
     - own _STALL_WARN_SECONDS: the same 1.0s threshold that decides
     - whether a stall gets logged there decides whether it's worth
     - surfacing here. -->
    <div v-if="info.loop_lag >= 1.0" class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.serverLag') }}</span>
      <span class="text-warning stream-info-lag">{{ info.loop_lag.toFixed(1) }}s</span>
    </div>
  </div>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import type { ConnectStreamInfo } from '@/services/connect/types'

const FALLBACK_INFO: ConnectStreamInfo = {
  label: '',
  content_type: '',
  transcoding: false,
  source_codec: null,
  source_sample_rate: null,
  source_bit_depth: null,
  source_bitrate_kbps: null,
  target_sample_rate: null,
  target_bit_depth: null,
  transcode_reason: null,
  active_connections: 0,
  loop_lag: 0,
}

// resolve_output_format()'s two transcoding tiers only ever produce one of
// these two content types (see core/streamer.py) — the copy tier (the only
// non-transcoding case) isn't in here at all, since targetLabel below is
// never read while info.transcoding is false. 192 kb/s is the fallback
// tier's own fixed bitrate (core/streamer.py's _FALLBACK_ARGS), not
// something read off the stream — always accurate, never a guess.
const TARGET_LABEL_FOR_CONTENT_TYPE: Record<string, string> = {
  'audio/flac': 'FLAC',
  'audio/mpeg': 'MP3, 192 kb/s',
}

// e.g. 96000 -> "96 kHz", 44100 -> "44.1 kHz". Shared by the source and
// target lines so a resampled dispatch reads as one comparison
// ("96 kHz / 24-bit" -> "48 kHz") rather than two differently-formatted
// numbers.
function formatKhz(hz: number): string {
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

export default {
  name: 'StreamInfoSection',
  computed: {
    connectStore() {
      return useConnectStore()
    },
    info(): ConnectStreamInfo {
      return this.connectStore.status?.stream_info ?? FALLBACK_INFO
    },
    // e.g. "FLAC, 96 kHz / 24-bit, 320 kb/s" — omits whichever parts weren't
    // detected (see OutputFormat's own docstring on why any of them can be
    // null — lossless codecs in particular never report a bitrate) rather
    // than showing a misleading "unknown".
    sourceLine(): string | null {
      const { source_codec, source_sample_rate, source_bit_depth, source_bitrate_kbps } = this.info
      if (!source_codec) return null
      const parts = [source_codec.toUpperCase()]
      if (source_sample_rate) {
        const rate = formatKhz(source_sample_rate)
        parts.push(source_bit_depth ? `${rate} / ${source_bit_depth}-bit` : rate)
      }
      if (source_bitrate_kbps) parts.push(`${source_bitrate_kbps} kb/s`)
      return parts.join(', ')
    },
    // Why it's being transcoded, in words. Backend-side keys (see
    // connect/core/streamer.py's REASON_* constants) rather than a
    // ready-made sentence, so this stays translatable; an unknown key
    // yields null instead of rendering the key itself.
    reasonText(): string | null {
      const key = this.info.transcode_reason
      if (!this.info.transcoding || !key) return null
      const path = `connect.streamInfo.reasons.${key}`
      return this.$te(path) ? this.$t(path) : null
    },
    // What's actually being sent to the device once transcoding is
    // happening — falls back to the raw content_type in the (currently
    // unreachable) case of a tier this map doesn't know about, rather than
    // showing nothing.
    //
    // The rate/depth are appended only where they were actually forced
    // away from the source's own (see ConnectStreamInfo.target_sample_rate)
    // — that's the case worth spelling out, since "FLAC" alone reads as an
    // unchanged copy of a FLAC source when it's really a downsampled one.
    targetLabel(): string {
      const base = TARGET_LABEL_FOR_CONTENT_TYPE[this.info.content_type] ?? this.info.content_type
      const { target_sample_rate, target_bit_depth } = this.info
      const changed = [
        target_sample_rate ? formatKhz(target_sample_rate) : null,
        target_bit_depth ? `${target_bit_depth}-bit` : null,
      ].filter(Boolean)
      return changed.length > 0 ? `${base}, ${changed.join(' / ')}` : base
    },
  },
}
</script>

<style scoped>
.stream-info-section {
  padding: 4px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Reuses ConnectDevicePicker.vue's own .device-group-heading look (an
 * "eyebrow-label" utility class, not scoped, so this just needs the same
 * spacing rather than redeclaring the class itself) — reads as one more
 * section of that card, not a bolted-on second component. */
.stream-info-heading {
  padding: 4px 0 2px;
}

/* Wraps instead of squeezing the label: these are whole sentences, unlike
 * every other value in this section. */
.stream-info-reason {
  text-align: right;
  line-height: 1.3;
}

.stream-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.8125rem;
}
</style>
