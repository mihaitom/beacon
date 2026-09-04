<template>
  <div class="seek-bar" style="gap: 8px">
    <!-- Radio has no position or length a bar could honestly represent
     - (see SongWaveform.vue's own comment on why it stopped trying) — an
     - elapsed-time readout replaces the whole label/bar row instead of
     - leaving a dead, maxed-out bar sitting there. While
     - playbackStore.radioBuffering (any cast target still filling its own
     - startup buffer — see connect/core/session.py's radio_is_buffering()
     - for the two ways the backend knows that, including the Sonos case
     - this used to miss entirely), the elapsed time would just be frozen
     - or misleading, so the same row swaps to an indeterminate bar instead
     - — same idiom ConnectDevicePicker.vue uses for its own device scan.
     - Deliberately just the bar, no label/icon alongside it (dropped
     - 2026-09-04): a second, stacked row for that text used to appear only
     - while buffering, which shoved the transport controls above around
     - every time buffering started or ended. One row, always this same
     - height, whichever of the two it's showing. -->
    <div v-if="playbackStore.radioStation" class="seek-bar__live">
      <v-progress-linear
        v-if="playbackStore.radioBuffering"
        indeterminate
        height="4"
        rounded
        color="primary"
      />
      <span v-else class="text-body-small text-medium-emphasis">{{
        $t('player.liveRadio', { time: formatTime(playbackStore.localPosition) })
      }}</span>
    </div>
    <template v-else>
      <span class="text-body-small text-medium-emphasis" style="width: 40px">{{
        formatTime(seekPreviewPosition ?? playbackStore.localPosition)
      }}</span>
      <song-waveform
        :model-value="seekPreviewPosition ?? playbackStore.localPosition"
        :duration="playbackStore.duration"
        :buffered="bufferedPosition"
        :disabled="!hasPlayable"
        :dimmed="!hasPlayable"
        @update:model-value="seekPreviewPosition = $event"
        @end="onSeekEnd"
      />
      <span class="text-body-small text-medium-emphasis" style="width: 40px">{{
        formatTime(playbackStore.duration)
      }}</span>
    </template>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import SongWaveform from './SongWaveform.vue'

export default {
  name: 'SeekBar',
  components: { SongWaveform },
  data() {
    return {
      // Non-null only while actively dragging the seek bar (SongWaveform)
      // — decouples its live visual position from playbackStore.seek()
      // itself, which used to fire on every drag tick via
      // @update:model-value. During casting each of those was a real
      // round-trip to the device (Sonos/Chromecast/etc.) — dozens of
      // overlapping seek commands during one drag made the device
      // audibly struggle to keep up and settle. Now @update:model-value
      // only updates this (purely visual), and the actual seek() call
      // fires once, from @end, when the drag finishes.
      seekPreviewPosition: null as number | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    hasPlayable() {
      return this.playbackStore.currentSong != null || this.playbackStore.radioStation != null
    },
    // 0 while casting, which buffers on the device itself, out of this
    // app's reach. Radio no longer reaches this at all — the template
    // above swaps the whole bar out for the live-elapsed label instead.
    bufferedPosition() {
      if (this.playbackStore.isCasting) return 0
      return this.playbackStore.bufferedPosition
    },
  },
  methods: {
    formatTime(seconds: number): string {
      const total = Math.max(0, Math.round(seconds))
      const minutes = Math.floor(total / 60)
      const secs = total % 60
      return `${minutes}:${String(secs).padStart(2, '0')}`
    },
    async onSeekEnd(value: number) {
      // Cleared only *after* seek() resolves (it sets localPosition to
      // this same value once done) — clearing first would flash the
      // slider back to the pre-seek position for whatever the round-trip
      // takes.
      await this.playbackStore.seek(value)
      this.seekPreviewPosition = null
    },
  },
}
</script>

<style scoped>
/* No max-width here — this deliberately fills ControlContainer.vue's own
 * width rather than matching CenterControls.vue's own narrower
 * button-cluster width; see ControlContainer.vue's own comment for why.
 * ControlContainer.vue itself now carries a 600px ceiling (an unclamped
 * seek bar reads as absurdly wide on a wide monitor) — this just follows
 * along via width: 100%, the same way it already follows that same
 * container's min-width floor below. min-width ties the *floor* to that
 * container's own min-width instead of just implicitly inheriting it via
 * width: 100%, so the dependency is visible here too, not only where the
 * number is actually declared — the one case it still matters: the outer
 * row squeezed narrow enough that even CenterControls.vue's own natural
 * width doesn't fit, see PlayerBar.vue's own min-width for the full
 * arithmetic. The intermittent overflow a max-width was once briefly
 * added *here* to "fix" wasn't actually caused by this being unbounded —
 * see SongWaveform.vue's own min-width comment for the real cause. */
.seek-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: var(--control-container-min-width, 220px);
  width: 100%;
}

.seek-bar__live {
  width: 100%;
  min-height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
