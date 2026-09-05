<template>
  <div class="radio-live">
    <!-- The one row a live stream gets where a track gets a seek bar. Two
     - states, deliberately the same height either way: while
     - playbackStore.radioBuffering — a cast target still filling its own
     - startup buffer (see connect/core/session.py's radio_is_buffering()),
     - or this device's own <audio> element retrying a dropped connection
     - (audioEngine.ts's reconnectOnDrop()) — the elapsed time would be
     - frozen or misleading, so the readout swaps for an indeterminate bar.
     - Just the bar, no label beside it: a second row for that text used to
     - appear only while buffering and shoved the transport controls above
     - around every time it started or ended (dropped 2026-09-04).
     -
     - Shared by SeekBar.vue and MobileTransportControls.vue, which had two
     - copies of this. -->
    <v-progress-linear
      v-if="playbackStore.radioBuffering"
      indeterminate
      height="4"
      rounded
      color="primary"
    />
    <!-- Nothing at all before the station has actually played: a station
     - restored from the last session is selected, not on air, and has no
     - listening time behind it either, so both halves of this readout
     - would be claims about something that has not happened. The row keeps
     - its height (the wrapper in SeekBar.vue/MobileTransportControls.vue
     - owns that), so nothing moves when it does start. Reported live
     - 2026-09-05: a restored station showed "Live" before play was ever
     - pressed. -->
    <template v-else-if="onAir || started">
      <!-- One sentence for a screen reader instead of four disconnected
       - fragments; the visible parts below are decoration around the same
       - information. Not a live region on purpose — the time changes every
       - second, and having that announced would be unusable. -->
      <span class="radio-live__sr">{{ srLabel }}</span>
      <div
        class="radio-live__readout"
        :class="{ 'radio-live__readout--off-air': !onAir }"
        aria-hidden="true"
      >
        <span class="radio-live__dot" :class="{ 'radio-live__dot--on-air': onAir }" />
        <span class="radio-live__label">{{ $t('player.live') }}</span>
        <span class="radio-live__separator">·</span>
        <span class="text-body-small text-medium-emphasis radio-live__time">{{ elapsed }}</span>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'

export default {
  name: 'RadioLiveStatus',
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    elapsed(): string {
      const total = Math.max(0, Math.round(this.playbackStore.localPosition))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    },
    /** Whether a station is coming out of a speaker right now. Drives both
     * the pulse and the whole readout's colour: paused mid-listen the
     * elapsed time is still worth showing, but a bright, blinking "on air"
     * over silence would be the one thing on this row that lies. */
    onAir(): boolean {
      return this.playbackStore.isPlaying
    },
    /** Whether this station has played at all in this session. False for
     * one restored from the last one and never started — see the template.
     * localPosition is the whole record of it: restoreFromStorage()
     * deliberately does not carry a radio elapsed across a restart, since
     * a live stream always reconnects at its edge rather than resuming. */
    started(): boolean {
      return this.playbackStore.localPosition > 0
    },
    srLabel(): string {
      return this.$t('player.liveRadio', { time: this.elapsed })
    },
  },
}
</script>

<style scoped>
.radio-live {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radio-live__readout {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Paused: the same readout, saying it is not on air right now rather than
 * disappearing — the listening time behind it is still real. The dot goes
 * hollow, which reads as "not connected" at the size a filled one reads as
 * "connected". */
.radio-live__readout--off-air .radio-live__dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px rgba(var(--v-theme-on-surface), 0.5);
}

.radio-live__readout--off-air .radio-live__label,
.radio-live__readout--off-air .radio-live__separator {
  color: rgba(var(--v-theme-on-surface), 0.5);
  opacity: 1;
}

/* box-shadow, not width/transform: the ring has to be able to grow past
 * the dot without taking any layout with it, on a row whose height is the
 * whole point of how it is built (see the template's own comment). */
.radio-live__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  flex-shrink: 0;
}

.radio-live__dot--on-air {
  animation: radio-live-ping 2.4s ease-out infinite;
}

@keyframes radio-live-ping {
  0% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0.45);
  }
  70% {
    box-shadow: 0 0 0 7px rgba(var(--v-theme-primary), 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0);
  }
}

/* A static dot rather than no dot: unlike the visualizer's canvas, this
 * still says everything it means to say standing still. */
@media (prefers-reduced-motion: reduce) {
  .radio-live__dot--on-air {
    animation: none;
  }
}

.radio-live__label {
  color: rgb(var(--v-theme-primary));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1;
}

.radio-live__separator {
  color: rgb(var(--v-theme-primary));
  opacity: 0.4;
  line-height: 1;
}

/* Proportional digits change width as they tick, which made the whole
 * centred row shuffle sideways once a second. */
.radio-live__time {
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.radio-live__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
