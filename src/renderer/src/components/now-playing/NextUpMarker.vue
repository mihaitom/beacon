<template>
  <!-- How the next song comes in: chevrons for a cut, two songs overlapping
   - for a crossfade, a metronome ticking at the shared tempo for a
   - beatmix. -->
  <span class="next-up-marker">
    <v-icon
      v-if="marker.kind === 'crossfade'"
      icon="mdi-vector-intersection"
      :size="iconSize"
      class="next-up-marker__crossfade"
      :aria-label="$t('home.nextUpCrossfade')"
      :title="$t('home.nextUpCrossfade')"
    />
    <v-icon
      v-else-if="marker.kind === 'beatmix'"
      icon="mdi-metronome"
      :size="iconSize"
      class="next-up-marker__beatmix"
      :style="beatStyle"
      :aria-label="$t('home.nextUpBeatmix')"
      :title="$t('home.nextUpBeatmix')"
    />
    <template v-else>
      <v-icon icon="mdi-chevron-right" :size="size" class="next-up-marker__chevron" />
      <v-icon
        icon="mdi-chevron-right"
        :size="size"
        class="next-up-marker__chevron next-up-marker__chevron--second"
      />
    </template>
  </span>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { NextUpMarker } from './source'

/** The marker between the song playing and the next one - in Now Playing's
 * corner, and beside the next-up line under the artwork. */
export default {
  name: 'NextUpMarker',
  props: {
    marker: {
      type: Object as PropType<NextUpMarker>,
      required: true,
    },
    /** A chevron's size; the single icons are drawn a little smaller, so
     * they weigh about as much as the pair. */
    size: {
      type: Number,
      default: 44,
    },
  },
  computed: {
    iconSize(): number {
      return Math.round(this.size * 0.86)
    },
    /** A beatmix's marker pulses once a beat. */
    beatStyle(): Record<string, string> {
      const bpm = this.marker.bpm
      return bpm && bpm > 0 ? { animationDuration: `${(60 / bpm).toFixed(3)}s` } : {}
    },
  },
}
</script>

<style scoped>
.next-up-marker {
  display: inline-flex;
  align-items: center;
}

/* Two chevrons nudging right in a loop, so the second reads as what follows
 * the first. */
.next-up-marker__chevron {
  animation: next-up-chevron 1.4s ease-in-out infinite;
}

.next-up-marker__chevron--second {
  animation-delay: 0.2s;
}

@keyframes next-up-chevron {
  0%,
  100% {
    opacity: 0.35;
    transform: translateX(-3px);
  }
  50% {
    opacity: 1;
    transform: translateX(0);
  }
}

/* A crossfade: the two songs overlap, so the marker slowly breathes in and
 * out rather than stepping. */
.next-up-marker__crossfade {
  animation: next-up-crossfade 2.8s ease-in-out infinite;
}

@keyframes next-up-crossfade {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

/* A beatmix: a beat-length pulse (see beatStyle), 0.5s until the tempo is
 * known. */
.next-up-marker__beatmix {
  animation: next-up-beat 0.5s ease-out infinite;
}

@keyframes next-up-beat {
  0% {
    opacity: 1;
    transform: scale(1.12);
  }
  100% {
    opacity: 0.55;
    transform: scale(1);
  }
}
</style>
