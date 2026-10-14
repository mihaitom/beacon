<template>
  <!-- Written tight: whitespace inside would end up before a colon after
   - it, and under the dotted line. -->
  <span>
    ·
    <span :class="{ 'next-up-transition--hint': transition.hint }"
      >{{ transition.label
      }}<v-tooltip v-if="transition.hint" activator="parent" location="top" :text="transition.hint"
    /></span>
  </span>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { NextUpTransition } from './source'

/** " · Crossfade" beside "Next up", and on hover why it is not a beatmix. */
export default {
  name: 'NextUpTransitionLabel',
  props: {
    transition: {
      type: Object as PropType<NextUpTransition>,
      required: true,
    },
  },
}
</script>

<style scoped>
.next-up-transition--hint {
  cursor: help;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
</style>
