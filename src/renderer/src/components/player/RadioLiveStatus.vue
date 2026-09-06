<template>
  <div class="radio-live">
    <!-- The one row a live stream gets where a track gets a seek bar.
     - Three states, deliberately the same height in all of them, in order
     - of how specific they are:
     -
     -  1. The connection is gone and nothing is still trying (below).
     -  2. playbackStore.radioBuffering — a cast target still filling its
     -     own startup buffer (see connect/core/session.py's
     -     radio_is_buffering()), or this device's own <audio> element
     -     retrying a dropped connection (audioEngine.ts's
     -     reconnectOnDrop()). The elapsed time would be frozen or
     -     misleading either way, so the readout swaps for an indeterminate
     -     bar. Just the bar, no label beside it: a second row for that text
     -     used to appear only while buffering and shoved the transport
     -     controls above around every time it started or ended (dropped
     -     2026-09-04).
     -  3. The ordinary "Live · {elapsed}" readout.
     -
     - Shared by SeekBar.vue and MobileTransportControls.vue, which had two
     - copies of this. -->
    <!-- The station is gone and this device has stopped retrying on its own
     - (stores/playback.ts's radioConnectionLost, the end of the reconnect
     - ladder in audioEngine.ts). Ahead of the buffering bar because it is
     - the more specific state: retrying and having stopped retrying are
     - mutually exclusive, and this is the one the listener can do something
     - about.
     -
     - The only state of the three that offers an action. Until this existed
     - a station that went quiet left the player bar with nothing on it that
     - could bring it back — the way out was to find the station again in
     - the library and start it over. -->
    <div v-if="playbackStore.radioConnectionLost" class="radio-live__lost">
      <span class="radio-live__dot radio-live__dot--lost" />
      <span class="text-body-small radio-live__lost-label">
        {{ $t('player.radioConnectionLost') }}
      </span>
      <v-btn
        class="radio-live__retry"
        variant="text"
        size="x-small"
        density="compact"
        color="primary"
        :text="$t('player.radioReconnect')"
        @click="playbackStore.reconnectRadio()"
      />
    </div>
    <v-progress-linear
      v-else-if="playbackStore.radioBuffering"
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
    /** m:ss, and h:mm:ss once a station has been on for an hour — a live
     * stream is the one thing in the app that runs long enough to reach
     * that, and until it did the readout counted on past 60 minutes as
     * "76:47". The hour part only appears when there is one, so a normal
     * listen keeps the shorter, narrower label. */
    elapsed(): string {
      const total = Math.max(0, Math.round(this.playbackStore.localPosition))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor(total / 60) % 60
      const seconds = total % 60
      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      }
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

.radio-live__lost {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Solid rather than the off-air state's hollow ring: "paused" is a state
 * the listener chose and the hollow dot reads as the absence of a
 * connection nobody asked for; this one is a fault, and it should be the
 * thing the eye lands on in a row that is otherwise all low-contrast. */
.radio-live__dot--lost {
  background: rgb(var(--v-theme-error));
}

.radio-live__lost-label {
  color: rgb(var(--v-theme-error));
  line-height: 1;
}

/* Vuetify sizes a text button's padding and letter-spacing for a toolbar,
 * which in a 24px row shared with a label reads as a button parked next to
 * some text rather than one line saying one thing. Trimmed to sit inside
 * the row the rest of this component is built to keep at a constant
 * height (see the template). */
.radio-live__retry {
  min-width: 0;
  padding-inline: 6px;
  letter-spacing: normal;
  text-transform: none;
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
