<template>
  <!-- One deliberate control for a two- or three-way choice, rather than a
   - dropdown for something with no room to grow. Hand-rolled buttons and
   - not a v-btn-toggle: Vuetify's own renders its selected button in the
   - surface colour unless it is given one, which is how this app ended up
   - with two of these looking lit and two looking grey. Here the active
   - state is the app's amber, once, for everybody.
   -
   - radiogroup/radio over a list of plain buttons — for a screen reader
   - this is one control with one answer, not several unrelated actions. -->
  <div class="segmented" role="radiogroup" :aria-label="label">
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      role="radio"
      class="segmented__option"
      :class="{ 'segmented__option--active': modelValue === option.value }"
      :aria-checked="modelValue === option.value"
      @click="$emit('update:modelValue', option.value)"
    >
      {{ option.title }}
    </button>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export interface SegmentedOption {
  title: string
  value: string
}

export default {
  name: 'SegmentedControl',
  props: {
    modelValue: {
      type: String,
      default: '',
    },
    options: {
      type: Array as PropType<SegmentedOption[]>,
      required: true,
    },
    /** Names the choice for a screen reader — the group's own buttons only
     * say what the options are, never what is being chosen. */
    label: {
      type: String,
      default: '',
    },
  },
  emits: ['update:modelValue'],
}
</script>

<style scoped>
.segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--beacon-hairline);
}

.segmented__option {
  flex: 1;
  padding: 8px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.segmented__option:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.segmented__option--active {
  background: rgba(var(--v-theme-primary), 0.12);
  color: #fdf6ec;
  font-weight: 600;
}
</style>
