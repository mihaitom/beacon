<template>
  <v-btn-toggle
    :model-value="modelValue"
    mandatory
    class="choice-tiles"
    :aria-label="label"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-btn v-for="option in options" :key="option.value" :value="option.value">
      <v-icon :icon="option.icon" size="20" class="choice-tiles__icon" />
      <span class="choice-tiles__text">
        <span class="choice-tiles__name">{{ option.name }}</span>
        <span class="text-body-small text-medium-emphasis">{{ option.hint }}</span>
      </span>
    </v-btn>
  </v-btn-toggle>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export interface ChoiceTile {
  value: string
  icon: string
  name: string
  hint: string
}

/** Tiles rather than a switch, for a choice whose options need saying. */
export default {
  name: 'ChoiceTiles',
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<ChoiceTile[]>, required: true },
    label: { type: String, required: true },
  },
  emits: ['update:modelValue'],
}
</script>

<style scoped>
.choice-tiles.v-btn-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  height: auto;
  overflow: visible;
  border-radius: 0;
}

.choice-tiles .v-btn {
  justify-content: flex-start;
  /* Grows with its text: a hint runs to two lines in some languages. */
  height: auto;
  min-height: 64px;
  min-width: 0;
  padding: 10px 14px;
  border: 1px solid var(--beacon-hairline);
  border-radius: 12px !important;
  transition: border-color 0.15s ease;
}

/* Outline and icon carry the choice; Vuetify's active overlay would fill the tile. */
.choice-tiles .v-btn--active {
  border-color: rgb(var(--v-theme-primary));
}

.choice-tiles .v-btn--active :deep(.v-btn__overlay) {
  opacity: 0;
}

.choice-tiles .v-btn--active .choice-tiles__icon {
  color: rgb(var(--v-theme-primary));
}

.choice-tiles__icon {
  margin-right: 10px;
}

.choice-tiles__text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  white-space: normal;
  text-align: left;
}

.choice-tiles__name {
  font-weight: 600;
}
</style>
