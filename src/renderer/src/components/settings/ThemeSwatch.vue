<template>
  <!-- A theme at a glance: its background, its surface and its accent, in
     - the proportions they take on a page. -->
  <span class="theme-swatch" aria-hidden="true">
    <span v-for="(color, index) in colors" :key="index" :style="{ background: color }" />
  </span>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export default {
  name: 'ThemeSwatch',
  props: {
    colors: { type: Array as PropType<string[]>, required: true },
  },
}
</script>

<style scoped>
.theme-swatch {
  display: inline-flex;
  flex: none;
  width: 54px;
  height: 28px;
  overflow: hidden;
  border-radius: 8px;
  outline: 1px solid rgba(var(--v-theme-on-surface), 0.16);
}

.theme-swatch > span {
  flex: 1;
}

.theme-swatch > span:first-child {
  flex: 2;
}
</style>
