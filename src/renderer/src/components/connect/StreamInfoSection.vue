<template>
  <!-- No icon/button of its own — rendered inline inside
   - ConnectDevicePicker.vue, which the user already opens to pick where
   - the music plays, rather than adding another always-visible affordance
   - somewhere in the app's permanent chrome. Shown whether or not a cast
   - is active: since the quality setting arrived, local playback has a
   - format worth knowing too. -->
  <div v-if="hasStream" class="stream-info-section">
    <div class="eyebrow-label stream-info-heading">{{ $t('connect.streamInfo.title') }}</div>
    <div class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.transcoding') }}</span>
      <span class="stream-info-value">
        <v-icon
          :icon="transcoding ? 'mdi-cog-sync-outline' : 'mdi-check-circle-outline'"
          :color="transcoding ? 'warning' : 'success'"
          size="small"
        />
        {{ transcoding ? targetLabel : $t('connect.streamInfo.no') }}
      </span>
    </div>
    <!-- Only while something is actually being converted, and only for a
     - reason this build knows a wording for — a key from a newer backend
     - renders as nothing rather than as a raw "codec_unknown" leaking
     - into the UI. -->
    <div v-if="reasonText" class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.reason') }}</span>
      <span class="stream-info-reason" :title="reasonText">{{ reasonShort }}</span>
    </div>
    <div v-if="sourceLine" class="stream-info-row">
      <span class="text-medium-emphasis">{{ $t('connect.streamInfo.source') }}</span>
      <span>{{ sourceLine }}</span>
    </div>
    <!-- Both of these describe a device pulling a stream from this backend,
     - which is exactly what does not happen for local playback — the
     - browser fetches its own audio and there is no cast connection to
     - report the health of. -->
    <template v-if="isCasting">
      <div class="stream-info-row">
        <span class="text-medium-emphasis">{{ $t('connect.streamInfo.connection') }}</span>
        <span class="stream-info-value">
          <v-icon
            :icon="castInfo.active_connections > 0 ? 'mdi-circle' : 'mdi-circle-outline'"
            :color="castInfo.active_connections > 0 ? 'success' : undefined"
            size="10"
          />
          {{
            castInfo.active_connections > 0
              ? $t('connect.streamInfo.connected')
              : $t('connect.streamInfo.idle')
          }}
        </span>
      </div>
      <!-- Only shown once there's something to actually flag — a healthy
       - 0.00s reading on every tick isn't information a casual glance
       - needs, only a real, currently-elevated stall is. See
       - core/loop_health.py's own _STALL_WARN_SECONDS: the same 1.0s
       - threshold that decides whether a stall gets logged there decides
       - whether it's worth surfacing here. -->
      <div v-if="castInfo.loop_lag >= 1.0" class="stream-info-row">
        <span class="text-medium-emphasis">{{ $t('connect.streamInfo.serverLag') }}</span>
        <span class="text-warning stream-info-lag">{{ castInfo.loop_lag.toFixed(1) }}s</span>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import type { ConnectStreamInfo } from '@/services/connect/types'
import type { LocalStreamPlan } from '@/services/streamQuality'
import { fetchLocalSourceInfo, type LocalSourceInfo } from '@/services/connect/localStreamInfo'

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
  target_bitrate_kbps: null,
  transcode_reason: null,
  active_connections: 0,
  loop_lag: 0,
}

const NO_LOCAL_SOURCE: LocalSourceInfo = {
  source_codec: null,
  source_sample_rate: null,
  source_bit_depth: null,
  source_bitrate_kbps: null,
}

// resolve_output_format()'s transcoding tiers only ever produce one of
// these content types (see core/streamer.py) — the copy tier (the only
// non-transcoding case) isn't in here at all, since castTargetLabel below
// is never read while transcoding is false. The mp3 entry carries no
// bitrate because the tier it belongs to can now be reached at several
// (the fallback's fixed 192k, or whatever ceiling the listener set), and a
// hardcoded number would be a guess for all but one of them. Each tier
// reports its own via target_bitrate_kbps instead.
const TARGET_LABEL_FOR_CONTENT_TYPE: Record<string, string> = {
  'audio/flac': 'FLAC',
  'audio/mpeg': 'MP3',
  'audio/aac': 'AAC',
}

// e.g. 96000 -> "96 kHz", 44100 -> "44.1 kHz". Shared by the source and
// target lines so a resampled dispatch reads as one comparison
// ("96 kHz / 24-bit" -> "48 kHz") rather than two differently-formatted
// numbers.
function formatKhz(hz: number): string {
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

/** Whether this panel has anything to describe at all. Nothing is loaded
 * before the first track, and a radio station has no local stream of ours
 * behind it (the URL is the station's own) — in both cases the panel says
 * nothing rather than describing a stream that isn't there.
 *
 * The radio check applies while casting too, not just locally: /play-url
 * (routes/playback.py) hands the target the station's raw URL directly and
 * leaves `current_output_format` on the generic mp3 fallback purely as
 * bookkeeping, never actually running it through the transcode pipeline
 * that field describes. Without this, the panel reported "transcoding to
 * MP3" for every cast radio station regardless of the quality setting, and
 * a "connected"/lag reading that reflects connections to connect's own
 * /stream proxy, which radio never uses either — none of stream_info means
 * anything here.
 *
 * The one radio case that *does* have something to describe is when the
 * device refused the station's own stream and connect fell back to
 * re-encoding it (core/streamer.py's REASON_DEVICE_REJECTED_STREAM) —
 * then there genuinely is a transcode, running through the very pipeline
 * this panel reports on, and hiding it would leave a listener wondering
 * why the station sounds different from the one they picked. Matched on
 * that reason specifically rather than on `transcoding`, which stays true
 * for every cast station purely as the bookkeeping described above.
 *
 * Exported (not just this component's own `hasStream` computed) so
 * ConnectDevicePicker.vue can decide whether the divider above this
 * section has anything below it to separate from — one answer, asked in
 * two places, rather than two conditions that could quietly drift apart. */
export const RADIO_REENCODED_REASON = 'device_rejected_stream'

export function hasStreamInfo(): boolean {
  const playback = usePlaybackStore()
  const connect = useConnectStore()
  if (playback.radioStation) {
    return connect.status?.stream_info?.transcode_reason === RADIO_REENCODED_REASON
  }
  return (
    connect.isActive || (playback.currentSong?.id != null && playback.activeLocalStream !== null)
  )
}

export default {
  name: 'StreamInfoSection',
  data() {
    return {
      localSource: NO_LOCAL_SOURCE as LocalSourceInfo,
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    isCasting(): boolean {
      return this.connectStore.isActive
    },
    castInfo(): ConnectStreamInfo {
      return this.connectStore.status?.stream_info ?? FALLBACK_INFO
    },
    /** The track this section is describing — null while nothing is loaded,
     * which is also what stops the local probe from being fetched. */
    currentSongId(): string | null {
      return this.playbackStore.currentSong?.id ?? null
    },
    /** What the running local stream actually is — *not* the setting.
     * Two things separate them, and reading the setting instead got both
     * wrong: a change only applies from the next song start, and the
     * setting is a ceiling, so a track already under it plays untouched
     * (see plan() in services/streamQuality.ts). */
    activePlan(): LocalStreamPlan | null {
      return this.playbackStore.activeLocalStream
    },
    // See hasStreamInfo() above for the actual logic and why it lives
    // there instead of only here.
    hasStream(): boolean {
      return hasStreamInfo()
    },
    transcoding(): boolean {
      if (this.isCasting) return this.castInfo.transcoding
      return this.activePlan !== null && this.activePlan.quality.format !== 'original'
    },
    /** What is actually being produced. For a cast that is connect's own
     * decision, reported back; locally it is what this app asked for when
     * it started the track. */
    targetLabel(): string {
      if (!this.isCasting) {
        if (!this.activePlan) return ''
        const { format, bitrate } = this.activePlan.quality
        return `${format.toUpperCase()}, ${bitrate} kb/s`
      }
      return this.castTargetLabel
    },
    // Falls back to the raw content_type in the (currently unreachable)
    // case of a tier this map doesn't know about, rather than showing
    // nothing.
    //
    // The rate/depth are appended only where they were actually forced away
    // from the source's own (see ConnectStreamInfo.target_sample_rate) —
    // that's the case worth spelling out, since "FLAC" alone reads as an
    // unchanged copy of a FLAC source when it's really a downsampled one.
    castTargetLabel(): string {
      const base =
        TARGET_LABEL_FOR_CONTENT_TYPE[this.castInfo.content_type] ?? this.castInfo.content_type
      const { target_sample_rate, target_bit_depth, target_bitrate_kbps } = this.castInfo
      const changed = [
        target_sample_rate ? formatKhz(target_sample_rate) : null,
        target_bit_depth ? `${target_bit_depth}-bit` : null,
        target_bitrate_kbps ? `${target_bitrate_kbps} kb/s` : null,
      ].filter(Boolean)
      return changed.length > 0 ? `${base}, ${changed.join(' / ')}` : base
    },
    // e.g. "FLAC, 96 kHz / 24-bit, 320 kb/s" — omits whichever parts weren't
    // detected (see OutputFormat's own docstring on why any of them can be
    // null — lossless codecs in particular never report a bitrate) rather
    // than showing a misleading "unknown".
    //
    // Both paths report the same four numbers from the same ffmpeg probe:
    // casting through the session status, local playback through
    // /stream/local/{id}/info. That is the whole reason that endpoint
    // exists — a Song carries neither sample rate nor bit depth.
    sourceLine(): string | null {
      const source = this.isCasting ? this.castInfo : this.localSource
      const { source_codec, source_sample_rate, source_bit_depth, source_bitrate_kbps } = source
      if (!source_codec) return null
      const parts = [source_codec.toUpperCase()]
      if (source_sample_rate) {
        const rate = formatKhz(source_sample_rate)
        parts.push(source_bit_depth ? `${rate} / ${source_bit_depth}-bit` : rate)
      }
      if (source_bitrate_kbps) parts.push(`${source_bitrate_kbps} kb/s`)
      return parts.join(', ')
    },
    // Why it's being transcoded, spelled out. Backend-side keys (see
    // connect/core/streamer.py's REASON_* constants) rather than a
    // ready-made sentence, so this stays translatable; an unknown key
    // yields null instead of rendering the key itself.
    //
    // Only ever the hover title, not the visible value — a whole sentence
    // in the right-hand column of a two-column row wrapped it into a
    // paragraph and pushed the rest of the section around.
    /** Whichever side is playing, why it is being converted — as a stable
     * key, translated below. Casting gets it from connect (see the
     * REASON_* constants in core/streamer.py); local playback decides it
     * client-side, since the decision itself is made there (see plan()).
     * `browser_unsupported` is the one key with no backend counterpart:
     * a cast device's own format limits are a different question, already
     * covered by `device_limit`. */
    reasonKey(): string | null {
      if (!this.isCasting) return this.activePlan?.reason ?? null
      return this.castInfo.transcoding ? this.castInfo.transcode_reason : null
    },
    reasonText(): string | null {
      const key = this.reasonKey
      if (!key) return null
      const path = `connect.streamInfo.reasons.${key}`
      return this.$te(path) ? this.$t(path) : null
    },
    // The couple of words actually shown in the row. Falls back to the
    // full sentence rather than to nothing if only the short wording is
    // missing for a key, so a half-translated locale still says something
    // — the row's own v-if is on reasonText, which stays the one thing
    // deciding whether there's a reason to show at all.
    reasonShort(): string | null {
      const key = this.reasonKey
      if (!this.reasonText || !key) return null
      const path = `connect.streamInfo.reasonsShort.${key}`
      return this.$te(path) ? this.$t(path) : this.reasonText
    },
  },
  watch: {
    currentSongId: { handler: 'loadLocalSource', immediate: true },
    isCasting: 'loadLocalSource',
  },
  methods: {
    /** Fetch the probe for the current track, unless casting is doing that
     * job already (its numbers ride along on the session status, with no
     * request of their own).
     *
     * Only ever runs while this section is mounted, i.e. while the picker
     * is actually open — the probe itself is cached backend-side, so
     * reopening the picker mid-track costs a round trip and no ffmpeg. */
    async loadLocalSource(): Promise<void> {
      const songId = this.currentSongId
      if (this.isCasting || !songId) {
        this.localSource = NO_LOCAL_SOURCE
        return
      }
      try {
        const info = await fetchLocalSourceInfo(songId)
        // The track can change while this is in flight; showing the
        // previous one's format under the new one's name would be worse
        // than showing nothing.
        if (this.currentSongId === songId) this.localSource = info
      } catch {
        // An unreachable backend or an unresolvable track leaves the source
        // row hidden. Everything else in the panel is derived locally and
        // stays correct, so there is nothing here worth an error banner.
        if (this.currentSongId === songId) this.localSource = NO_LOCAL_SOURCE
      }
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

/* The dotted underline and the help cursor are the only hint that the
 * shortened wording has a fuller explanation behind it — without them a
 * bare "Container format" reads as the whole answer and nobody hovers. */
.stream-info-reason {
  text-align: right;
  line-height: 1.3;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
}

.stream-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.8125rem;
}

/* The right-hand column of a row where a value sits next to its status
 * icon. Replaces the inline flex styling those two rows used to repeat. */
.stream-info-value {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
