<template>
  <div class="nav-history">
    <v-btn
      icon="mdi-chevron-left"
      variant="text"
      density="comfortable"
      size="small"
      class="nav-history__button"
      :disabled="!history.canGoBack"
      :title="$t('nav.back')"
      :aria-label="$t('nav.back')"
      @click="goBack"
    />
    <v-btn
      icon="mdi-chevron-right"
      variant="text"
      density="comfortable"
      size="small"
      class="nav-history__button"
      :disabled="!history.canGoForward"
      :title="$t('nav.forward')"
      :aria-label="$t('nav.forward')"
      @click="goForward"
    />
  </div>
</template>

<script lang="ts">
// The pair of chevrons in the app bar. Deliberately shown even with
// nothing to go back to rather than appearing and disappearing: a control
// that comes and goes cannot be aimed at, and its greyed-out state is
// itself the answer to "is there anything behind this page".
import { goBack, goForward, navigationHistory } from '@/services/navigationHistory'

export default {
  name: 'NavHistoryControls',
  computed: {
    history() {
      return navigationHistory
    },
  },
  methods: {
    goBack,
    goForward,
  },
}
</script>

<style scoped>
.nav-history {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-inline-start: 8px;
}

/* Quieter than a destination in the rail - this is chrome, and the two
 * arrows sit right next to the app's own name. */
.nav-history__button {
  color: rgba(255, 255, 255, 0.65);
}

.nav-history__button:hover:not(.v-btn--disabled) {
  color: rgba(255, 255, 255, 0.95);
}
</style>
