<template>
  <input
    ref="input"
    type="range"
    class="touch-volume-slider"
    :min="0"
    :max="max"
    :step="1"
    :value="modelValue"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :style="fillStyle"
    @input="onInput"
    @change="onChange"
  />
</template>

<script lang="ts">
/**
 * The volume slider on the phone, as a native `<input type="range">`.
 *
 * Vuetify's VSlider does not survive a real finger. It binds touchstart
 * passively and its move listener is `{ passive: true }` too
 * (vuetify/lib/components/VSlider/slider.js), so it cannot call
 * preventDefault and has no way to stop the browser deciding mid-gesture
 * that the drag was a scroll - only `touch-action` can, and on real
 * hardware that was not enough. The symptom was a drag that moved a few
 * percent and stopped, or did nothing, roughly every second attempt, while
 * a tap always worked: a tap needs no tracking, a drag does. It reproduced
 * on no emulator, because an emulated drag travels exactly horizontally and
 * a finger never does.
 *
 * A native range input is dragged by the browser itself, so there is no
 * gesture to lose. The LAN remote has always used one and has never had
 * this (see connect/static/remote/js/views/now-playing.js); this is the
 * same element, styled to match.
 *
 * `input` fires per move and `change` on release - the same split the
 * remote uses, so the speaker is told once per drag rather than per frame.
 */
export default {
  name: 'TouchVolumeSlider',
  props: {
    modelValue: { type: Number, required: true },
    max: { type: Number, default: 100 },
    disabled: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
  },
  emits: ['update:modelValue', 'commit'],
  computed: {
    /** WebKit has no ::-moz-range-progress equivalent, so the filled part
     * is painted as a gradient on the element - same approach as the
     * remote's range.js. */
    fillStyle(): string {
      const percent =
        this.max > 0 ? Math.max(0, Math.min(100, (this.modelValue / this.max) * 100)) : 0
      return `--fill: ${percent}%`
    },
  },
  methods: {
    onInput(event: Event) {
      this.$emit('update:modelValue', Number((event.target as HTMLInputElement).value))
    },
    onChange(event: Event) {
      this.$emit('commit', Number((event.target as HTMLInputElement).value))
    },
  },
}
</script>

<style scoped>
.touch-volume-slider {
  flex: 1;
  min-width: 0;
  height: 32px;
  margin: 0;
  padding: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
  /* The browser drags this one itself, but the page still must not treat a
   * slightly-off-horizontal drag as its own scroll. */
  touch-action: none;
}

.touch-volume-slider:disabled {
  opacity: 0.4;
}

/* Track and thumb have to be declared per engine - a selector list
 * containing an unknown pseudo-element is dropped whole by both. */
.touch-volume-slider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(
    to right,
    rgb(var(--v-theme-primary)) var(--fill),
    rgba(var(--v-theme-on-surface), 0.2) var(--fill)
  );
}

.touch-volume-slider::-moz-range-track {
  height: 6px;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.2);
}

.touch-volume-slider::-moz-range-progress {
  height: 6px;
  border-radius: 3px;
  background: rgb(var(--v-theme-primary));
}

.touch-volume-slider::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  /* Centres the 20px thumb on the 6px track: WebKit lays the thumb out
   * from the top of the track rather than its middle. */
  margin-top: -7px;
}

.touch-volume-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
}
</style>
