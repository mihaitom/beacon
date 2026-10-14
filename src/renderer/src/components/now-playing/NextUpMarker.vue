<template>
  <span class="next-up-marker">
    <v-icon icon="mdi-chevron-right" :size="size" class="next-up-marker__chevron" />
    <v-icon
      icon="mdi-chevron-right"
      :size="size"
      class="next-up-marker__chevron next-up-marker__chevron--second"
    />
  </span>
</template>

<script lang="ts">
/** The marker between the song playing and the next one - in Now Playing's
 * corner, and beside the next-up line under the artwork. How the next song
 * comes in (a crossfade, a beatmix) is said in the label beside it, not
 * here. */
export default {
  name: 'NextUpMarker',
  props: {
    size: {
      type: Number,
      default: 44,
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
</style>
