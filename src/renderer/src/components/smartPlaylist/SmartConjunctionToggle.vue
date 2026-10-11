<template>
  <v-btn-toggle
    :model-value="modelValue"
    mandatory
    :disabled="readonly"
    density="compact"
    color="primary"
    variant="outlined"
    divided
    rounded="pill"
    class="smart-conjunction"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-btn value="all">{{ $t('smartPlaylists.all') }}</v-btn>
    <v-btn value="any">{{ $t('smartPlaylists.any') }}</v-btn>
  </v-btn-toggle>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { Conjunction } from '@/services/navidrome/smartRules'

/** "all" or "any", set in the middle of the sentence it belongs to. */
export default {
  name: 'SmartConjunctionToggle',
  props: {
    modelValue: { type: String as PropType<Conjunction>, required: true },
    readonly: { type: Boolean, default: false },
  },
  emits: {
    'update:modelValue': (value: Conjunction) => value === 'all' || value === 'any',
  },
}
</script>

<style scoped>
/* Sits in a line of text, so its labels keep the text's case and weight
 * rather than Vuetify's tracked capitals - the same reset the settings tabs
 * get (see docs/styleguide.md). */
.smart-conjunction :deep(.v-btn) {
  text-transform: none;
  letter-spacing: normal;
  font-weight: 600;
}
</style>
