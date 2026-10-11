<template>
  <v-menu :disabled="readonly" location="bottom start">
    <template #activator="{ props: menuProps }">
      <button
        v-bind="menuProps"
        type="button"
        class="smart-field"
        :class="{ 'smart-field--readonly': readonly }"
        :disabled="readonly"
      >
        <v-icon :icon="icon(field)" size="18" class="smart-field__icon" />
        <span class="smart-field__label">{{ $t(`smartPlaylists.fields.${field}`) }}</span>
        <v-icon v-if="!readonly" icon="mdi-chevron-down" size="16" class="smart-field__chevron" />
      </button>
    </template>
    <v-list density="compact" class="smart-field__menu">
      <template v-for="topic in topics" :key="topic.id">
        <context-menu-section :label="$t(`smartPlaylists.topics.${topic.id}`)" />
        <v-list-item
          v-for="key in topic.fields"
          :key="key"
          :active="key === field"
          color="primary"
          @click="$emit('select', key)"
        >
          <template #prepend><v-icon :icon="icon(key)" size="small" /></template>
          <v-list-item-title>{{ $t(`smartPlaylists.fields.${key}`) }}</v-list-item-title>
        </v-list-item>
      </template>
    </v-list>
  </v-menu>
</template>

<script lang="ts">
import ContextMenuSection from '@/components/library/ContextMenuSection.vue'
import { FIELDS, type FieldTopic } from '@/services/navidrome/smartRules'
import { FIELD_ICONS } from './fieldIcons'

const TOPICS: FieldTopic[] = ['song', 'listening', 'file']

/**
 * The field a rule is about, and the menu to pick another: grouped by what
 * the field describes, each with its icon, rather than one alphabetical
 * list of names - "Last played" belongs with "Play count", not between
 * "Genre" and "Loved".
 */
export default {
  name: 'SmartFieldMenu',
  components: { ContextMenuSection },
  props: {
    field: { type: String, required: true },
    readonly: { type: Boolean, default: false },
  },
  emits: {
    select: (key: string) => typeof key === 'string',
  },
  data() {
    return {
      topics: TOPICS.map((id) => ({
        id,
        fields: FIELDS.filter((field) => field.topic === id).map((field) => field.key),
      })),
    }
  },
  methods: {
    icon(key: string): string {
      return FIELD_ICONS[key] ?? 'mdi-help-circle-outline'
    },
  },
}
</script>

<style scoped>
/* A control that reads as the first word of the sentence the rule makes:
 * the field's own icon in amber, its name at body weight, no box until it
 * is pointed at. */
.smart-field {
  /* A <button> for the keyboard and screen readers, without the browser's
   * own grey button face. */
  appearance: none;
  background: none;
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 10px;
  border-radius: 8px;
  color: inherit;
  font: inherit;
  font-weight: 600;
  transition: background-color 0.15s;
}

.smart-field:not(.smart-field--readonly):hover,
.smart-field:focus-visible {
  background: var(--beacon-hover);
}

.smart-field--readonly {
  cursor: default;
}

.smart-field__icon {
  color: rgb(var(--v-theme-primary));
}

.smart-field__label {
  white-space: nowrap;
}

.smart-field__chevron {
  opacity: 0.6;
}

/* Every field fits without scrolling on a laptop screen; a phone scrolls. */
.smart-field__menu {
  max-height: 70vh;
  overflow-y: auto;
}
</style>
