<template>
  <v-menu :close-on-content-click="false" location="bottom start">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        rounded="pill"
        variant="flat"
        prepend-icon="mdi-filter-variant"
        class="library-filter-button"
        :class="{ 'library-filter-button--active': activeCount > 0 }"
      >
        {{ $t('library.songFilter.button') }}
        <span v-if="activeCount" class="library-filter-button__count">{{ activeCount }}</span>
      </v-btn>
    </template>
    <v-list density="compact" class="library-filter-menu">
      <v-menu v-for="def in shownFields" :key="def.field" submenu :close-on-content-click="false">
        <template #activator="{ props: submenuProps }">
          <v-list-item
            v-bind="submenuProps"
            :title="$t(def.labelKey)"
            :subtitle="summary(def)"
            :active="Boolean(modelValue[def.field]?.length)"
          >
            <template #append><v-icon icon="mdi-menu-right" size="small" /></template>
          </v-list-item>
        </template>
        <v-list density="compact" class="library-filter-options">
          <v-list-item
            v-for="{ option, count } in optionsByField[def.field]"
            :key="option"
            @click="toggle(def.field, option)"
          >
            <template #prepend>
              <v-checkbox-btn
                :model-value="isPicked(def.field, option)"
                density="compact"
                tabindex="-1"
              />
            </template>
            <v-list-item-title>{{ optionLabel(def.field, option) }}</v-list-item-title>
            <template #append>
              <span class="text-body-small text-medium-emphasis">{{ $n(count) }}</span>
            </template>
          </v-list-item>
        </v-list>
      </v-menu>
      <v-divider />
      <v-list-item
        :disabled="!activeCount"
        prepend-icon="mdi-filter-off-outline"
        :title="$t('library.songFilter.reset')"
        @click="$emit('update:modelValue', {})"
      />
    </v-list>
  </v-menu>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  UNKNOWN_OPTION,
  activeFilterCount,
  filterOptionLabel,
  filterOptions,
  type FilterField,
  type FilterFieldDef,
  type LibraryFilters,
} from '@/services/library/libraryFilter'

/** The filter button of a library list (songs, albums, artists) and its
 * menu: one entry per field, each with a submenu of what the library holds
 * there and how many items each option has. Several options of one field
 * mean any of them; several fields mean all of them. */
export default {
  name: 'LibraryFilterMenu',
  props: {
    /** The whole list, not the filtered one: an option's count says what
     * picking it brings in, not what is left after the others. */
    items: { type: Array as PropType<unknown[]>, required: true },
    fields: { type: Array as PropType<FilterFieldDef<never>[]>, required: true },
    modelValue: { type: Object as PropType<LibraryFilters>, required: true },
  },
  emits: ['update:modelValue'],
  computed: {
    activeCount(): number {
      return activeFilterCount(this.modelValue)
    },
    optionsByField(): Partial<Record<FilterField, { option: string; count: number }[]>> {
      const now = Date.now()
      const fields = this.fields as FilterFieldDef<unknown>[]
      return Object.fromEntries(
        fields.map((def) => [def.field, filterOptions(this.items, def, now)]),
      )
    },
    /** A field the server sent nothing for has only its unknown option -
     * nothing to pick between. */
    shownFields(): FilterFieldDef<never>[] {
      return this.fields.filter((def) =>
        this.optionsByField[def.field]?.some(
          ({ option, count }) => option !== UNKNOWN_OPTION && count > 0,
        ),
      )
    },
  },
  methods: {
    /** What is picked, under the field's name - so the menu itself says
     * what the list is filtered by. */
    summary(def: FilterFieldDef<never>): string | undefined {
      const picked = this.modelValue[def.field]
      if (!picked?.length) return undefined
      return picked.map((option) => this.optionLabel(def.field, option)).join(', ')
    },
    isPicked(field: FilterField, option: string): boolean {
      return this.modelValue[field]?.includes(option) ?? false
    },
    toggle(field: FilterField, option: string) {
      const picked = this.modelValue[field] ?? []
      const next = picked.includes(option)
        ? picked.filter((existing) => existing !== option)
        : [...picked, option]
      this.$emit('update:modelValue', { ...this.modelValue, [field]: next })
    },
    optionLabel(field: FilterField, option: string): string {
      return filterOptionLabel(field, option, this.$t)
    },
  },
}
</script>

<style scoped>
/* The same flat 40px pill as the field and the select beside it. */
.library-filter-button.v-btn {
  height: 40px;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, rgb(var(--v-theme-surface)));
  color: rgba(var(--v-theme-on-surface), 0.75);
}

.library-filter-button--active.v-btn {
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.14);
}

.library-filter-button__count {
  margin-left: 6px;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 9999px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  font-size: 0.75rem;
  line-height: 20px;
  text-align: center;
}

.library-filter-menu {
  min-width: 240px;
}

/* A library's genres run into the hundreds. */
.library-filter-options {
  min-width: 220px;
  max-height: 360px;
  overflow-y: auto;
}
</style>
