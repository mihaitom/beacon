<template>
  <!-- Two tiles rather than a switch: "public" alone does not say who gets
   - to see it, and the answer is the whole reason to stop and choose. -->
  <v-btn-toggle
    :model-value="modelValue ? 'public' : 'private'"
    mandatory
    class="playlist-visibility"
    :aria-label="$t('playlists.public')"
    @update:model-value="$emit('update:modelValue', $event === 'public')"
  >
    <v-btn v-for="option in options" :key="option.value" :value="option.value">
      <v-icon :icon="option.icon" size="20" class="playlist-visibility__icon" />
      <span class="playlist-visibility__text">
        <span class="playlist-visibility__name">{{ option.name }}</span>
        <span class="text-body-small text-medium-emphasis">{{ option.hint }}</span>
      </span>
    </v-btn>
  </v-btn-toggle>
</template>

<script lang="ts">
export default {
  name: 'PlaylistVisibility',
  props: {
    /** True for public. */
    modelValue: { type: Boolean, required: true },
  },
  emits: ['update:modelValue'],
  computed: {
    options() {
      return [
        {
          value: 'private',
          icon: 'mdi-lock-outline',
          name: this.$t('playlists.private'),
          hint: this.$t('playlists.privateHint'),
        },
        {
          value: 'public',
          icon: 'mdi-earth',
          name: this.$t('playlists.public'),
          hint: this.$t('playlists.publicHint'),
        },
      ]
    },
  },
}
</script>

<style scoped>
.playlist-visibility.v-btn-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  height: auto;
  overflow: visible;
  border-radius: 0;
}

.playlist-visibility .v-btn {
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
.playlist-visibility .v-btn--active {
  border-color: rgb(var(--v-theme-primary));
}

.playlist-visibility .v-btn--active :deep(.v-btn__overlay) {
  opacity: 0;
}

.playlist-visibility .v-btn--active .playlist-visibility__icon {
  color: rgb(var(--v-theme-primary));
}

.playlist-visibility__icon {
  margin-right: 10px;
}

.playlist-visibility__text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  white-space: normal;
  text-align: left;
}

.playlist-visibility__name {
  font-weight: 600;
}
</style>
