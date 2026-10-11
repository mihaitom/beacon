<template>
  <v-menu :disabled="readonly || operators.length < 2" location="bottom start">
    <template #activator="{ props: menuProps }">
      <button
        v-bind="menuProps"
        type="button"
        class="smart-operator"
        :class="{ 'smart-operator--fixed': readonly || operators.length < 2 }"
        :disabled="readonly || operators.length < 2"
      >
        {{ $t(`smartPlaylists.operators.${operator}`) }}
        <v-icon
          v-if="!readonly && operators.length > 1"
          icon="mdi-chevron-down"
          size="16"
          class="smart-operator__chevron"
        />
      </button>
    </template>
    <v-list density="compact">
      <v-list-item
        v-for="option in operators"
        :key="option"
        :active="option === operator"
        color="primary"
        @click="$emit('select', option)"
      >
        <v-list-item-title>{{ $t(`smartPlaylists.operators.${option}`) }}</v-list-item-title>
      </v-list-item>
    </v-list>
  </v-menu>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { Operator } from '@/services/navidrome/smartRules'

/**
 * The verb of a rule's sentence ("contains", "in the last"), worded per
 * kind of field and picked from a menu. A field with only one way of being
 * compared (loved, compilation) shows it as plain text.
 */
export default {
  name: 'SmartOperatorMenu',
  props: {
    operator: { type: String as PropType<Operator>, required: true },
    operators: { type: Array as PropType<Operator[]>, required: true },
    readonly: { type: Boolean, default: false },
  },
  emits: {
    select: (operator: Operator) => typeof operator === 'string',
  },
}
</script>

<style scoped>
/* Quieter than the field before it: the field says what, this says how,
 * and the eye should land on the field and the value. */
.smart-operator {
  /* A <button> for the keyboard and screen readers, without the browser's
   * own grey button face. */
  appearance: none;
  background: none;
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  padding: 0 8px;
  border-radius: 8px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  font: inherit;
  white-space: nowrap;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.smart-operator:not(.smart-operator--fixed):hover,
.smart-operator:focus-visible {
  background: var(--beacon-hover);
  color: rgb(var(--v-theme-on-surface));
}

.smart-operator--fixed {
  cursor: default;
}

.smart-operator__chevron {
  opacity: 0.6;
}
</style>
