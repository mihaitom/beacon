<template>
  <v-dialog
    :model-value="modelValue"
    max-width="520"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog">
      <v-card-title>{{ $t('milkdrop.title') }}</v-card-title>

      <v-card-text>
        <h3 class="section-title milkdrop-menu__heading">{{ $t('milkdrop.switchTitle') }}</h3>
        <v-btn-toggle
          :model-value="settings.switchMode"
          mandatory
          class="beacon-view-toggle beacon-view-toggle--text"
          :aria-label="$t('milkdrop.switchTitle')"
          @update:model-value="store.set({ switchMode: $event })"
        >
          <v-btn value="song">{{ $t('milkdrop.switchSong') }}</v-btn>
          <v-btn value="time">{{ $t('milkdrop.switchTime') }}</v-btn>
          <v-btn value="fixed">{{ $t('milkdrop.switchFixed') }}</v-btn>
        </v-btn-toggle>
        <div v-if="settings.switchMode === 'time'" class="milkdrop-menu__interval">
          <v-slider
            :model-value="settings.intervalSeconds"
            :min="minInterval"
            :max="maxInterval"
            :step="15"
            color="primary"
            hide-details
            :aria-label="$t('milkdrop.interval')"
            class="milkdrop-menu__grow"
            @update:model-value="store.set({ intervalSeconds: $event })"
          />
          <span class="text-body-medium milkdrop-menu__interval-value">
            {{ formatInterval(settings.intervalSeconds) }}
          </span>
        </div>
        <p class="setting__hint">{{ switchHint }}</p>

        <h3 class="section-title milkdrop-menu__heading">{{ $t('milkdrop.fpsTitle') }}</h3>
        <v-btn-toggle
          :model-value="settings.fps"
          mandatory
          class="beacon-view-toggle beacon-view-toggle--text"
          :aria-label="$t('milkdrop.fpsTitle')"
          @update:model-value="store.set({ fps: $event })"
        >
          <v-btn :value="0">{{ $t('milkdrop.fpsDisplay') }}</v-btn>
          <v-btn :value="60">60</v-btn>
          <v-btn :value="30">30</v-btn>
        </v-btn-toggle>
        <p class="setting__hint">{{ $t('milkdrop.fpsHint') }}</p>

        <h3 class="section-title milkdrop-menu__heading">{{ $t('milkdrop.presetsTitle') }}</h3>
        <p class="setting__hint milkdrop-menu__intro">{{ $t('milkdrop.presetsHint') }}</p>
        <v-text-field
          v-model="query"
          :placeholder="$t('milkdrop.search')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          hide-details
          clearable
          class="milkdrop-menu__search"
        />
        <ul class="beacon-panel beacon-panel--flush milkdrop-menu__list">
          <li
            v-for="entry in shown"
            :key="entry.key"
            class="milkdrop-menu__row"
            :class="{ 'milkdrop-menu__row--current': entry.key === settings.preset }"
          >
            <v-checkbox-btn
              :model-value="settings.preferred.includes(entry.key)"
              :aria-label="$t('milkdrop.prefer', { name: entry.name })"
              density="compact"
              @update:model-value="store.togglePreferred(entry.key)"
            />
            <button type="button" class="milkdrop-menu__name" @click="store.choose(entry.key)">
              <span class="text-body-medium">{{ entry.name }}</span>
              <span v-if="entry.custom" class="text-body-small text-medium-emphasis">
                {{ $t('milkdrop.uploaded') }}
              </span>
            </button>
            <v-btn
              v-if="entry.custom"
              icon="mdi-delete-outline"
              variant="text"
              density="comfortable"
              size="small"
              :title="$t('milkdrop.delete')"
              :aria-label="$t('milkdrop.delete')"
              @click="remove(entry.key)"
            />
          </li>
          <li v-if="shown.length === 0" class="milkdrop-menu__row text-medium-emphasis">
            {{ $t('milkdrop.noMatch') }}
          </li>
        </ul>
        <p v-if="uploadMessage" class="setting__status milkdrop-menu__status">
          {{ uploadMessage }}
        </p>
      </v-card-text>

      <v-card-actions>
        <v-btn variant="text" prepend-icon="mdi-upload" :loading="uploading" @click="pickFiles">
          {{ $t('milkdrop.upload') }}
        </v-btn>
        <input
          ref="fileInput"
          type="file"
          accept=".milk,.json"
          multiple
          class="milkdrop-menu__file"
          @change="onFiles"
        />
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  useMilkdropStore,
  type MilkdropSettings,
} from '@/stores/milkdrop'
import type { MilkdropPresetEntry } from '@/services/milkdrop/presets'

export default {
  name: 'MilkdropDialog',
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      query: '' as string | null,
      uploading: false,
      uploadMessage: '',
      minInterval: MIN_INTERVAL_SECONDS,
      maxInterval: MAX_INTERVAL_SECONDS,
    }
  },
  computed: {
    store() {
      return useMilkdropStore()
    },
    settings(): MilkdropSettings {
      return this.store.settings
    },
    shown(): MilkdropPresetEntry[] {
      const query = (this.query ?? '').trim().toLocaleLowerCase()
      if (!query) return this.store.presets
      return this.store.presets.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
    },
    switchHint(): string {
      if (this.settings.switchMode === 'fixed') return this.$t('milkdrop.switchFixedHint')
      return this.settings.preferred.length > 0
        ? this.$t('milkdrop.poolHint', this.settings.preferred.length)
        : this.$t('milkdrop.poolEmptyHint')
    },
  },
  watch: {
    // Afresh on every opening: another device may have uploaded since.
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open) void this.store.loadCustom()
        else this.uploadMessage = ''
      },
    },
  },
  methods: {
    formatInterval(seconds: number): string {
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `0:${rest}`
    },
    pickFiles(): void {
      ;(this.$refs.fileInput as HTMLInputElement).click()
    },
    async onFiles(event: Event): Promise<void> {
      const input = event.target as HTMLInputElement
      const files = [...(input.files ?? [])]
      input.value = ''
      if (files.length === 0) return
      this.uploading = true
      this.uploadMessage = ''
      try {
        const { added, failed } = await this.store.upload(files)
        const parts: string[] = []
        if (added.length > 0) parts.push(this.$t('milkdrop.uploadAdded', added.length))
        if (failed.length > 0) {
          parts.push(this.$t('milkdrop.uploadFailed', { files: failed.join(', ') }))
        }
        this.uploadMessage = parts.join(' ')
      } finally {
        this.uploading = false
      }
    },
    async remove(key: string): Promise<void> {
      try {
        await this.store.remove(key)
      } catch (error) {
        console.error('[milkdrop] Delete failed:', error)
        this.uploadMessage = this.$t('milkdrop.deleteFailed')
      }
    },
  },
}
</script>

<style scoped>
.milkdrop-menu__heading {
  margin: 20px 0 10px;
}

.milkdrop-menu__heading:first-child {
  margin-top: 0;
}

.milkdrop-menu__interval {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.milkdrop-menu__grow {
  flex: 1;
}

.milkdrop-menu__interval-value {
  min-width: 3.5em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.setting__hint {
  margin-top: 6px;
}

.milkdrop-menu__intro {
  margin-bottom: 10px;
}

.milkdrop-menu__search {
  margin-bottom: 10px;
}

.milkdrop-menu__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.milkdrop-menu__row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 8px;
  border-bottom: 1px solid var(--beacon-hairline);
}

.milkdrop-menu__row:last-child {
  border-bottom: 0;
}

.milkdrop-menu__row--current {
  background: rgba(var(--v-theme-primary), 0.12);
}

.milkdrop-menu__name {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 8px 4px;
  text-align: left;
  color: inherit;
  overflow-wrap: anywhere;
}

.milkdrop-menu__status {
  margin-top: 10px;
}

.milkdrop-menu__file {
  display: none;
}
</style>
