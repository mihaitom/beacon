<template>
  <div class="smart-opaque">
    <v-icon icon="mdi-lock-outline" size="18" class="smart-opaque__icon" />
    <div class="smart-opaque__text">
      <div class="smart-opaque__label">{{ $t('smartPlaylists.opaque') }}</div>
      <code class="smart-opaque__json" :title="json">{{ json }}</code>
    </div>
    <v-tooltip :text="$t('smartPlaylists.opaqueHint')" location="top" open-on-click>
      <template #activator="{ props: tooltipProps }">
        <v-btn
          v-bind="tooltipProps"
          icon="mdi-information-outline"
          variant="text"
          size="small"
          :aria-label="$t('smartPlaylists.opaqueHint')"
        />
      </template>
    </v-tooltip>
    <v-btn
      v-if="!readonly"
      icon="mdi-close"
      variant="text"
      size="small"
      :title="$t('smartPlaylists.removeCondition')"
      :aria-label="$t('smartPlaylists.removeCondition')"
      @click="$emit('remove')"
    />
  </div>
</template>

<script lang="ts">
/**
 * A rule the editor cannot edit - an unknown field, a deeper group, a
 * value in another shape - shown as it is written rather than hidden, and
 * saved back unchanged. It can be removed, which is the one edit that
 * cannot misread it.
 */
export default {
  name: 'SmartOpaqueRow',
  props: {
    raw: { type: null, required: true },
    readonly: { type: Boolean, default: false },
  },
  emits: {
    remove: () => true,
  },
  computed: {
    json(): string {
      return JSON.stringify(this.raw)
    },
  },
}
</script>

<style scoped>
.smart-opaque {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px 8px 14px;
  border-radius: 8px;
  border: 1px dashed var(--beacon-hairline);
}

.smart-opaque__icon {
  opacity: 0.6;
}

.smart-opaque__text {
  flex: 1;
  min-width: 0;
}

.smart-opaque__label {
  font-weight: 600;
}

/* One line, cut with an ellipsis; the whole rule is in the title. */
.smart-opaque__json {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.8rem;
  opacity: 0.7;
}
</style>
