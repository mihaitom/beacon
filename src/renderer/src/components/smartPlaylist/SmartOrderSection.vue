<template>
  <section class="smart-order">
    <h3 class="eyebrow-label panel-title">{{ $t('smartPlaylists.orderAndSize') }}</h3>

    <div class="smart-order__line">
      <span class="smart-order__words">{{ $t('smartPlaylists.sortedBy') }}</span>
      <v-select
        :model-value="sortField"
        :items="sortItems"
        :placeholder="rawSortText"
        :readonly="readonly"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        class="smart-order__field"
        @update:model-value="setSortField"
      >
        <template #item="{ props: itemProps, item }">
          <v-list-item v-bind="itemProps">
            <template #prepend><v-icon :icon="item.icon" size="small" /></template>
          </v-list-item>
        </template>
        <template #selection="{ item }">
          <v-icon :icon="item.icon" size="small" class="smart-order__field-icon" />
          {{ item.title }}
        </template>
      </v-select>
      <v-btn-toggle
        v-if="sortField && sortField !== 'random'"
        :model-value="descending"
        mandatory
        :disabled="readonly"
        density="compact"
        variant="outlined"
        color="primary"
        divided
        class="smart-order__direction"
        @update:model-value="setDescending"
      >
        <v-btn
          :value="false"
          icon="mdi-sort-ascending"
          :title="$t('smartPlaylists.ascending')"
          :aria-label="$t('smartPlaylists.ascending')"
        />
        <v-btn
          :value="true"
          icon="mdi-sort-descending"
          :title="$t('smartPlaylists.descending')"
          :aria-label="$t('smartPlaylists.descending')"
        />
      </v-btn-toggle>
    </div>
    <p v-if="rawSortText" class="text-body-small text-medium-emphasis smart-order__kept">
      {{ rawSortText }}
    </p>

    <div class="smart-order__line">
      <v-switch
        :model-value="limit !== null"
        :readonly="readonly"
        color="primary"
        density="compact"
        hide-details
        inset
        class="smart-order__switch"
        :aria-label="$t('smartPlaylists.limit')"
        @update:model-value="$emit('update', { limit: $event ? lastLimit : null })"
      />
      <template v-if="limit !== null">
        <span class="smart-order__words">{{ $t('smartPlaylists.limit') }}</span>
        <v-text-field
          :model-value="limit"
          type="number"
          min="1"
          :readonly="readonly"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          single-line
          class="smart-order__limit"
          @update:model-value="setLimit"
        />
        <span class="smart-order__words">{{ $t('smartPlaylists.limitSuffix') }}</span>
      </template>
      <span v-else class="smart-order__words">{{ $t('smartPlaylists.limitOff') }}</span>
    </div>

    <div class="smart-order__line">
      <span class="smart-order__words">{{ $t('smartPlaylists.refresh') }}</span>
      <v-select
        :model-value="refreshDelay"
        :items="refreshItems"
        :readonly="readonly"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        class="smart-order__refresh"
        @update:model-value="$emit('update', { refreshDelay: $event })"
      />
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { SORT_FIELDS, type SmartRules, type Sort } from '@/services/navidrome/smartRules'
import { FIELD_ICONS } from './fieldIcons'

/** Navidrome's duration strings for the choices offered; null leaves it to
 * the server's own setting. */
const REFRESH_CHOICES: { value: string | null; key: string }[] = [
  { value: null, key: 'default' },
  { value: '1h', key: 'hourly' },
  { value: '1d', key: 'daily' },
  { value: '1w', key: 'weekly' },
]

/** What the switch brings back when a limit is turned on. */
const DEFAULT_LIMIT = 100

/** Sorting, a song limit and how often Navidrome rebuilds the list - the
 * settings of the playlist as a whole, below its rules. */
export default {
  name: 'SmartOrderSection',
  props: {
    sort: { type: Object as PropType<Sort>, default: null },
    limit: { type: Number as PropType<number | null>, default: null },
    refreshDelay: { type: String as PropType<string | null>, default: null },
    readonly: { type: Boolean, default: false },
  },
  emits: {
    update: (changes: Partial<Pick<SmartRules, 'sort' | 'limit' | 'refreshDelay'>>) =>
      typeof changes === 'object',
  },
  data() {
    return {
      // So switching the limit off and on again gives back the number.
      lastLimit: this.limit ?? DEFAULT_LIMIT,
    }
  },
  computed: {
    /** Title when nothing is set, which is what Navidrome sorts by then. */
    sortField(): string | null {
      if (!this.sort) return 'title'
      return 'field' in this.sort ? this.sort.field : null
    },
    descending(): boolean {
      return !!this.sort && 'field' in this.sort && this.sort.descending
    },
    rawSortText(): string {
      if (!this.sort || !('raw' in this.sort)) return ''
      const written = Object.values(this.sort.raw).filter(Boolean).join(' ')
      return this.$t('smartPlaylists.customSort', { sort: written })
    },
    sortItems(): { title: string; value: string; icon: string }[] {
      return SORT_FIELDS.map((key) => ({
        title: this.$t(`smartPlaylists.fields.${key}`),
        value: key,
        icon: FIELD_ICONS[key] ?? 'mdi-sort',
      }))
    },
    refreshItems(): { title: string; value: string | null }[] {
      const items = REFRESH_CHOICES.map((choice) => ({
        title: this.$t(`smartPlaylists.refreshOptions.${choice.key}`),
        value: choice.value,
      }))
      // A value set elsewhere stays selectable, so opening the editor does
      // not quietly change it.
      if (this.refreshDelay && !REFRESH_CHOICES.some((c) => c.value === this.refreshDelay)) {
        items.push({
          title: this.$t('smartPlaylists.refreshKept', { delay: this.refreshDelay }),
          value: this.refreshDelay,
        })
      }
      return items
    },
  },
  watch: {
    limit(value: number | null) {
      if (value !== null) this.lastLimit = value
    },
  },
  methods: {
    setSortField(field: string): void {
      this.$emit('update', { sort: { field, descending: this.descending } })
    },
    setDescending(descending: boolean): void {
      if (this.sortField) this.$emit('update', { sort: { field: this.sortField, descending } })
    },
    setLimit(raw: string): void {
      const value = Math.floor(Number(raw))
      if (Number.isFinite(value) && value > 0) this.$emit('update', { limit: value })
    },
  },
}
</script>

<style scoped>
.smart-order {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.smart-order__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.smart-order__words {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.smart-order__field {
  flex: 0 1 240px;
  min-width: 180px;
}

.smart-order__field-icon {
  margin-right: 8px;
  color: rgb(var(--v-theme-primary));
}

.smart-order__direction :deep(.v-btn) {
  min-width: 44px;
}

.smart-order__kept {
  margin: -4px 0 0;
}

.smart-order__switch {
  flex: 0 0 auto;
}

.smart-order__limit {
  flex: 0 0 auto;
  width: 104px;
}

.smart-order__refresh {
  flex: 0 1 300px;
  min-width: 200px;
}
</style>
