<template>
  <!-- At the right edge of Now Playing and without a scrim: what it changes
     - is the picture behind it, which has to stay in view. Not the window's
     - edge, where an open queue would be under it. -->
  <v-dialog
    :model-value="modelValue"
    width="420"
    scrollable
    :scrim="false"
    transition="slide-x-reverse-transition"
    class="milkdrop-menu-overlay"
    :style="{ '--milkdrop-menu-right': `${rightInset}px` }"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog milkdrop-menu">
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
        <div
          v-if="settings.switchMode === 'time'"
          class="milkdrop-menu__interval"
          @wheel="onIntervalWheel"
        >
          <v-slider
            :model-value="intervalIndex"
            :min="0"
            :max="lastInterval"
            :step="1"
            color="primary"
            hide-details
            :aria-label="$t('milkdrop.interval')"
            class="milkdrop-menu__grow"
            @update:model-value="setInterval($event)"
          />
          <span class="text-body-medium milkdrop-menu__interval-value">
            {{ formatInterval(settings.intervalSeconds) }}
          </span>
        </div>
        <p class="setting__hint">{{ switchHint }}</p>

        <milkdrop-preset-picker
          ref="picker"
          :entries="store.presets"
          :current="current"
          :preferred="settings.preferred"
          @choose="store.choose($event)"
          @toggle-preferred="store.togglePreferred($event)"
          @remove="remove($event)"
        />
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
import { wheelStep } from '@/services/volumeWheel'
import MilkdropPresetPicker from './MilkdropPresetPicker.vue'
import {
  INTERVAL_STEPS,
  intervalStep,
  useMilkdropStore,
  type MilkdropSettings,
} from '@/stores/milkdrop'
import type { PropType } from 'vue'

export default {
  name: 'MilkdropDialog',
  components: { MilkdropPresetPicker },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    /** The preset on screen right now, picked out in the list. */
    current: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** How far Now Playing's right edge is from the window's. */
    rightInset: {
      type: Number,
      default: 0,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      uploading: false,
      uploadMessage: '',
      lastInterval: INTERVAL_STEPS.length - 1,
      wheelCarry: 0,
    }
  },
  computed: {
    store() {
      return useMilkdropStore()
    },
    settings(): MilkdropSettings {
      return this.store.settings
    },
    /** The timer on the slider's scale, which runs through INTERVAL_STEPS. */
    intervalIndex(): number {
      return intervalStep(this.settings.intervalSeconds)
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
        if (open) {
          void this.store.loadCustom()
          void this.$nextTick(() => this.revealCurrent())
        } else {
          this.uploadMessage = ''
        }
      },
    },
  },
  methods: {
    /** Opens on the preset on screen, wherever it is in the list. */
    revealCurrent(): void {
      ;(this.$refs.picker as { revealCurrent(): void } | undefined)?.revealCurrent()
    },
    setInterval(index: number): void {
      const step = INTERVAL_STEPS[Math.min(this.lastInterval, Math.max(0, Math.round(index)))]!
      this.store.set({ intervalSeconds: step })
    },
    onIntervalWheel(event: WheelEvent): void {
      // Sideways scrolling and ctrl+wheel (zoom) keep doing what they did.
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      const { step, carry } = wheelStep(event, this.wheelCarry)
      this.wheelCarry = carry
      if (step !== 0) this.setInterval(this.intervalIndex + step)
    },
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

.milkdrop-menu__status {
  margin-top: 10px;
}

.milkdrop-menu__file {
  display: none;
}
</style>

<!-- Unscoped: v-dialog teleports its overlay out of this component. -->
<style>
.milkdrop-menu-overlay.v-dialog {
  justify-content: flex-end;
}

.milkdrop-menu-overlay.v-dialog > .v-overlay__content {
  margin: 16px;
  margin-right: calc(16px + var(--milkdrop-menu-right, 0px));
}
</style>
