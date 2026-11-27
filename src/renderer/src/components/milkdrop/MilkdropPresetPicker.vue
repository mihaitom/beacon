<template>
  <div>
    <template v-if="destinations.length">
      <h3 class="section-title milkdrop-picker__heading">{{ $t('milkdrop.jumpTitle') }}</h3>
      <!-- Nothing stays picked: the preset moves on from there by itself. -->
      <v-select
        :model-value="null"
        :items="destinations"
        item-title="label"
        item-value="index"
        :placeholder="$t('milkdrop.jumpPlaceholder')"
        :aria-label="$t('milkdrop.jumpTitle')"
        prepend-inner-icon="mdi-map-marker-outline"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        @update:model-value="jump"
      />
      <p class="setting__hint">{{ $t('milkdrop.jumpHint') }}</p>
    </template>

    <h3 class="section-title milkdrop-picker__heading">{{ $t('milkdrop.presetsTitle') }}</h3>
    <p class="setting__hint milkdrop-picker__intro">
      {{ preferred ? $t('milkdrop.presetsHint') : $t('milkdrop.presetsHintPlain') }}
    </p>
    <v-text-field
      v-model="query"
      :placeholder="$t('milkdrop.search')"
      prepend-inner-icon="mdi-magnify"
      variant="solo-filled"
      density="compact"
      hide-details
      clearable
      class="milkdrop-picker__search"
    />
    <ul class="beacon-panel beacon-panel--flush milkdrop-picker__list">
      <li
        v-for="entry in shown"
        :key="entry.key"
        class="milkdrop-picker__row"
        :class="{ 'milkdrop-picker__row--current': entry.key === current }"
        @click="$emit('choose', entry.key)"
      >
        <v-checkbox-btn
          v-if="preferred"
          :model-value="preferred.includes(entry.key)"
          :aria-label="$t('milkdrop.prefer', { name: entry.name })"
          density="compact"
          class="milkdrop-picker__tick"
          @click.stop
          @update:model-value="$emit('toggle-preferred', entry.key)"
        />
        <button
          type="button"
          class="milkdrop-picker__name"
          :aria-current="entry.key === current ? 'true' : undefined"
        >
          <span class="text-body-medium">{{ entry.name }}</span>
          <span v-if="entry.custom" class="text-body-small text-medium-emphasis">
            {{ $t('milkdrop.uploaded') }}
          </span>
        </button>
        <span
          v-if="entry.demanding"
          role="img"
          class="milkdrop-picker__demanding"
          :title="$t('milkdrop.demanding')"
          :aria-label="$t('milkdrop.demanding')"
        >
          <v-icon icon="mdi-expansion-card" size="small" />
        </span>
        <v-btn
          v-if="entry.custom"
          icon="mdi-delete-outline"
          variant="text"
          density="comfortable"
          size="small"
          :title="$t('milkdrop.delete')"
          :aria-label="$t('milkdrop.delete')"
          @click.stop="$emit('remove', entry.key)"
        />
      </li>
      <li v-if="shown.length === 0" class="milkdrop-picker__row text-medium-emphasis">
        {{ $t('milkdrop.noMatch') }}
      </li>
    </ul>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { MILKY_WAY_DESTINATIONS, MILKY_WAY_KEY, jumpTo } from '@/services/milkdrop/milkyWayJumps'
import {
  FRACTAL_ZOOM_DESTINATIONS,
  FRACTAL_ZOOM_KEY,
  jumpToScene,
} from '@/services/milkdrop/fractalZoomJumps'
import {
  ATTRACTOR_DESTINATIONS,
  STRANGE_ATTRACTORS_KEY,
  jumpToSystem,
} from '@/services/milkdrop/attractorJumps'
import type { MilkdropPresetEntry } from '@/services/milkdrop/presets'

/** The presets to pick from, and the places the one on screen can be sent
 * to. Store-free, so the party guest page can show it too: the app's menu
 * (MilkdropDialog) hands it the account's presets and pool, the guest's
 * (party/components/GuestMilkdropButton) the shipped ones alone. */
export default {
  name: 'MilkdropPresetPicker',
  props: {
    entries: {
      type: Array as PropType<readonly MilkdropPresetEntry[]>,
      required: true,
    },
    /** The preset on screen right now, picked out in the list. */
    current: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** The presets ticked for automatic changes; null shows no ticks. */
    preferred: {
      type: Array as PropType<readonly string[] | null>,
      default: null,
    },
  },
  emits: ['choose', 'toggle-preferred', 'remove'],
  data() {
    return { query: '' as string | null }
  },
  computed: {
    shown(): readonly MilkdropPresetEntry[] {
      const query = (this.query ?? '').trim().toLocaleLowerCase()
      if (!query) return this.entries
      return this.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
    },
    /** The places the preset on screen can be sent to, for the three of
     * Beacon's own that roam; none for any other. */
    destinations(): { label: string; index: number; jump: () => void }[] {
      const jumps =
        this.current === MILKY_WAY_KEY
          ? MILKY_WAY_DESTINATIONS.map((to) => ({ label: to.label, jump: () => jumpTo(to) }))
          : this.current === FRACTAL_ZOOM_KEY
            ? FRACTAL_ZOOM_DESTINATIONS.map((to) => ({
                label: to.label,
                jump: () => jumpToScene(to),
              }))
            : this.current === STRANGE_ATTRACTORS_KEY
              ? ATTRACTOR_DESTINATIONS.map((to) => ({
                  label: to.label,
                  jump: () => jumpToSystem(to),
                }))
              : []
      return jumps.map((to, index) => ({ ...to, index }))
    },
  },
  methods: {
    jump(index: number | null): void {
      if (index != null) this.destinations[index]?.jump()
    },
    /** Brings the preset on screen into view, wherever it is in the list. */
    revealCurrent(): void {
      ;(this.$el as HTMLElement)
        .querySelector('.milkdrop-picker__row--current')
        ?.scrollIntoView?.({ block: 'center' })
    },
  },
}
</script>

<style scoped>
.milkdrop-picker__heading {
  margin: 20px 0 10px;
}

.setting__hint {
  margin-top: 6px;
}

.milkdrop-picker__intro {
  margin-bottom: 10px;
}

.milkdrop-picker__search {
  margin-bottom: 10px;
}

.milkdrop-picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.milkdrop-picker__row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 44px;
  padding: 0 6px 0 2px;
  border-bottom: 1px solid var(--beacon-hairline);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.milkdrop-picker__row:last-child {
  border-bottom: 0;
}

.milkdrop-picker__row:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

/* The amber of a selected segment, with a bar at the edge so it still
 * reads as "this one" in a long list scrolled past quickly. */
.milkdrop-picker__row--current,
.milkdrop-picker__row--current:hover {
  background: rgba(var(--v-theme-primary), 0.14);
  box-shadow: inset 3px 0 0 rgb(var(--v-theme-primary));
}

.milkdrop-picker__row--current .milkdrop-picker__name {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}

/* Vuetify's selection control grows to fill its row by default. */
.milkdrop-picker__tick {
  flex: none;
}

.milkdrop-picker__name {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 8px 4px;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  color: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.milkdrop-picker__name:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
  border-radius: 6px;
}

.milkdrop-picker__demanding {
  display: inline-flex;
  flex: none;
  padding: 0 8px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
