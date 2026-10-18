<template>
  <v-empty-state class="beacon-empty" :title="title" :text="text">
    <template #media>
      <div class="beacon-empty__icon">
        <v-icon :icon="icon" size="28" />
      </div>
    </template>
    <template v-if="$slots.default" #actions>
      <slot />
    </template>
  </v-empty-state>
</template>

<script lang="ts">
// The one shape for "there is nothing here": a quiet icon, what is missing,
// and - where there is one - how to change that. v-empty-state does the
// layout; this pins its look, so the empty pages in the app stop each
// picking their own size of icon and title. Replaced the tonal info alerts,
// which read as a warning about something rather than as an empty page.
export default {
  name: 'EmptyState',
  props: {
    icon: { type: String, required: true },
    title: { type: String, required: true },
    // How to fill it, when the page can say: "Tap ♡ on a song...".
    text: { type: String, default: undefined },
  },
}
</script>

<style scoped>
.beacon-empty {
  min-height: 0;
  padding: 48px 16px;
}

.beacon-empty__icon {
  display: inline-grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.05);
  border: 1px solid var(--beacon-hairline);
}

.beacon-empty__icon :deep(.v-icon) {
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.beacon-empty :deep(.v-empty-state__content) {
  padding: 16px 0 0;
}

.beacon-empty :deep(.v-empty-state__title) {
  font-size: 1.1rem;
  font-weight: 600;
}

.beacon-empty :deep(.v-empty-state__text) {
  max-width: 44ch;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
