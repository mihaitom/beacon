<template>
  <v-bottom-sheet
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card
      class="cast-sheet"
      :class="{ 'cast-sheet--dragging': drag.active }"
      :style="dragOffset ? { transform: `translateY(${dragOffset}px)` } : undefined"
    >
      <!-- The grabber and the title bar are where the sheet is pulled down
       - from, the way a phone's own sheets close. The list below scrolls
       - and is left to do that. -->
      <div
        class="cast-sheet__top"
        @pointerdown="onDragStart"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragCancel"
      >
        <span class="cast-sheet__grabber" aria-hidden="true" />
        <header class="cast-sheet__head">
          <div class="cast-sheet__titles">
            <span class="cast-sheet__title">{{ $t('connect.playingOn') }}</span>
            <span class="cast-sheet__subtitle text-body-small">{{ subtitle }}</span>
          </div>
          <button
            type="button"
            class="cast-sheet__round mobile-device-picker__rescan"
            :aria-label="$t('connect.rescan')"
            :disabled="connectStore.isScanning"
            @pointerdown.stop
            @click="connectStore.refreshDevices(true)"
          >
            <v-progress-circular
              v-if="connectStore.isScanning"
              indeterminate
              size="18"
              width="2"
              color="primary"
            />
            <v-icon v-else icon="mdi-refresh" size="20" />
          </button>
          <button
            type="button"
            class="cast-sheet__round"
            :aria-label="$t('common.close')"
            @pointerdown.stop
            @click="close"
          >
            <v-icon icon="mdi-close" size="20" />
          </button>
        </header>
      </div>

      <div v-if="hasNotices" class="cast-sheet__notices">
        <connect-error-banner
          v-if="connectStore.errors.apiUnreachable"
          variant="api-unreachable"
          @retry="connectStore.refreshDevices(true)"
        />
        <connect-error-banner v-if="authStore.health?.ffmpeg === false" variant="ffmpeg-missing" />
        <v-alert
          v-if="connectStore.errors.message"
          type="error"
          variant="tonal"
          density="compact"
          closable
          @click:close="connectStore.clearError()"
        >
          {{ connectStore.errors.message }}
          <div v-if="connectStore.errors.detail" class="cast-sheet__error-detail">
            {{ connectStore.errors.detail }}
          </div>
        </v-alert>
      </div>

      <div class="cast-sheet__body">
        <!-- What is playing, each row its own volume slider - the same rows
         - as the desktop menu's left half, a size up for a thumb. -->
        <section class="cast-sheet__section">
          <segmented-control
            v-if="showModeSwitch"
            class="cast-sheet__mode"
            :model-value="groupVolumeStore.mode"
            :options="modeOptions"
            :label="$t('connect.groupVolume')"
            @update:model-value="onModeChange"
          />

          <div v-if="connectStore.isActive" class="cast-sheet__faders">
            <volume-fader
              v-if="volumeGroup"
              master
              class="cast-sheet__fader cast-sheet__fader--master"
              :label="$t('connect.allSpeakers')"
              :model-value="groupVolumeLevel"
              :floor="groupVolumeStore.mode === 'relative' ? groupVolumeFloor : null"
              @update:model-value="onMasterChange"
              @start="volumeGroup.forEach(startVolumeDrag)"
              @end="volumeGroup.forEach(endVolumeDrag)"
            >
              <template #icon><v-icon icon="mdi-speaker-multiple" size="22" /></template>
            </volume-fader>
            <volume-fader
              v-for="target in connectStore.activeTargets"
              :key="`${target.type}:${target.name}`"
              class="cast-sheet__fader"
              :label="target.name"
              :model-value="deviceLevel(target)"
              :adjustable="connectStore.isVolumeCapable(target.type)"
              :plain="perSpeakerPlain || !connectStore.isVolumeCapable(target.type)"
              :remove-label="$t('connect.removeSpeaker', { name: target.name })"
              @update:model-value="onDeviceChange(target, $event)"
              @start="startVolumeDrag(target)"
              @end="endVolumeDrag(target)"
              @remove="remove(target)"
            >
              <template #icon>
                <airplay-icon v-if="target.type === 'airplay'" />
                <v-icon v-else :icon="typeIcon(target.type)" size="20" />
              </template>
            </volume-fader>
          </div>
          <div v-else class="cast-sheet__here">
            <v-icon icon="mdi-cellphone" size="22" />
            <span class="cast-sheet__here-name">{{ $t('connect.thisDevice') }}</span>
            <v-icon icon="mdi-check-circle" size="20" />
          </div>

          <button
            v-if="connectStore.isActive"
            type="button"
            class="cast-sheet__local"
            @click="playHereAndClose"
          >
            <v-icon icon="mdi-cellphone" size="20" />
            {{ $t('connect.playHereInstead') }}
          </button>
        </section>

        <section class="cast-sheet__section">
          <div class="eyebrow-label cast-sheet__heading">{{ $t('connect.addHeading') }}</div>
          <div v-if="availableGroups.length === 0" class="text-body-medium cast-sheet__empty">
            {{ emptyAvailableText }}
          </div>
          <template v-for="group in availableGroups" :key="group.type">
            <div class="text-body-small cast-sheet__type">{{ group.label }}</div>
            <div class="cast-sheet__panel">
              <available-device-row
                v-for="entry in group.entries"
                :key="`${entry.type}:${entry.device.name}`"
                class="cast-sheet__available"
                :device="entry.device"
                :type="entry.type"
                :busy="busyKey === `${entry.type}:${entry.device.name}`"
                @add="add(entry)"
                @take-over="takeOver(entry)"
                @pair="openPairing(entry.device.name)"
              />
            </div>
          </template>
        </section>

        <stream-info-section class="cast-sheet__stream-info" />

        <v-btn
          v-if="connectStore.isActive"
          class="cast-sheet__stop"
          block
          variant="tonal"
          color="error"
          @click="stopAllAndClose"
        >
          {{ $t('connect.stopAll') }}
        </v-btn>
      </div>

      <airplay-pairing-dialog v-model="pairingOpen" :device-name="pairingDeviceName" />
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import SegmentedControl from '@/components/SegmentedControl.vue'
import AirplayIcon from '@/components/connect/AirplayIcon.vue'
import AirplayPairingDialog from '@/components/connect/AirplayPairingDialog.vue'
import AvailableDeviceRow from '@/components/connect/AvailableDeviceRow.vue'
import ConnectErrorBanner from '@/components/connect/ConnectErrorBanner.vue'
import StreamInfoSection from '@/components/connect/StreamInfoSection.vue'
import VolumeFader from '@/components/connect/VolumeFader.vue'
import { castMenuMixin } from '@/components/connect/castMenuMixin'

/** How far the sheet has to be pulled down to close, or how fast. */
const DISMISS_DISTANCE_PX = 96
const DISMISS_VELOCITY_PX_PER_MS = 0.5

/**
 * The phone's cast menu: the desktop menu's two halves stacked in one
 * column, in a sheet that is pulled down to close. Shares everything it
 * does with ConnectDevicePicker.vue through castMenuMixin.
 */
export default {
  name: 'MobileDevicePicker',
  components: {
    AirplayIcon,
    AirplayPairingDialog,
    AvailableDeviceRow,
    ConnectErrorBanner,
    SegmentedControl,
    StreamInfoSection,
    VolumeFader,
  },
  mixins: [castMenuMixin],
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      drag: { active: false, pointerId: -1, startY: 0, lastY: 0, lastTime: 0, velocity: 0 },
      dragOffset: 0,
    }
  },
  computed: {
    subtitle(): string {
      return this.connectStore.isActive ? this.playingHeading : this.$t('connect.thisDevice')
    },
  },
  watch: {
    // immediate, so a sheet that is already open when it mounts asks too.
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        this.dragOffset = 0
        if (open) void this.connectStore.refreshDevices()
      },
    },
  },
  methods: {
    menuShown(): boolean {
      return this.modelValue
    },
    /** The sheet has no room for a second place to report a failure, so
     * one that left nothing for its alert goes to the toast every other
     * phone failure uses. */
    reportCastError() {
      if (this.connectStore.errors.message) return
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('connect.title'),
        message: this.$t('connect.unknownError'),
      })
    },
    close() {
      this.$emit('update:modelValue', false)
    },
    /** Nothing is left to adjust once the sound is back on the phone. */
    async stopAllAndClose() {
      this.close()
      await this.stopAll()
    },
    async playHereAndClose() {
      this.close()
      await this.playHere()
    },
    onDragStart(event: PointerEvent) {
      if (event.button !== 0) return
      this.drag = {
        active: true,
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTime: event.timeStamp,
        velocity: 0,
      }
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    onDragMove(event: PointerEvent) {
      if (!this.drag.active || event.pointerId !== this.drag.pointerId) return
      const elapsed = Math.max(1, event.timeStamp - this.drag.lastTime)
      this.drag.velocity = (event.clientY - this.drag.lastY) / elapsed
      this.drag.lastY = event.clientY
      this.drag.lastTime = event.timeStamp
      // Only downwards: the sheet is already as tall as it gets.
      this.dragOffset = Math.max(0, event.clientY - this.drag.startY)
    },
    onDragEnd(event: PointerEvent) {
      if (!this.drag.active || event.pointerId !== this.drag.pointerId) return
      const dismiss =
        this.dragOffset > DISMISS_DISTANCE_PX ||
        (this.dragOffset > 0 && this.drag.velocity > DISMISS_VELOCITY_PX_PER_MS)
      this.drag.active = false
      if (dismiss) this.close()
      else this.dragOffset = 0
    },
    onDragCancel() {
      this.drag.active = false
      this.dragOffset = 0
    },
  },
}
</script>

<style scoped>
.cast-sheet {
  display: flex;
  flex-direction: column;
  max-height: 88dvh;
  border-radius: 20px 20px 0 0;
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Under the finger, not easing after it. */
.cast-sheet--dragging {
  transition: none;
}

.cast-sheet__top {
  flex: none;
  /* The browser would otherwise take a downward pull as a page scroll. */
  touch-action: none;
  cursor: grab;
}

.cast-sheet__grabber {
  display: block;
  width: 36px;
  height: 5px;
  margin: 8px auto 0;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.22);
}

.cast-sheet__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 14px 20px;
}

.cast-sheet__titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.cast-sheet__title {
  font-size: 1.35rem;
  font-weight: 700;
  line-height: 1.2;
}

.cast-sheet__subtitle {
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.cast-sheet__round {
  appearance: none;
  border: 0;
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.08);
  color: rgba(var(--v-theme-on-surface), 0.75);
}

.cast-sheet__round:active {
  background: rgba(var(--v-theme-on-surface), 0.14);
}

.cast-sheet__round:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.cast-sheet__notices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 16px 12px;
}

.cast-sheet__error-detail {
  margin-top: 4px;
  font-size: 0.75rem;
  opacity: 0.7;
  word-break: break-word;
}

.cast-sheet__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 16px calc(16px + env(safe-area-inset-bottom));
}

.cast-sheet__section + .cast-sheet__section {
  margin-top: 22px;
}

.cast-sheet__mode {
  margin-bottom: 10px;
}

.cast-sheet__faders {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* A thumb's height rather than a pointer's. */
.cast-sheet__fader {
  height: 56px;
  border-radius: 12px;
}

/* The one large thing in the sheet: the volume of everything at once. */
.cast-sheet__fader--master {
  height: 68px;
  margin-bottom: 4px;
}

.cast-sheet__fader--master :deep(.fader__label) {
  font-size: 1.05rem;
}

.cast-sheet__fader--master :deep(.fader__value) {
  font-size: 1.05rem;
}

/* Local playback, playing: lit the way a playing speaker is. */
.cast-sheet__here {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 60px;
  padding: 0 16px;
  border-radius: 12px;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}

.cast-sheet__here-name {
  flex: 1;
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface));
}

.cast-sheet__local {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 48px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: 12px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  text-align: left;
}

.cast-sheet__local:active {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.cast-sheet__heading {
  padding: 0 4px 2px;
}

.cast-sheet__type {
  padding: 10px 4px 6px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.cast-sheet__empty {
  padding: 10px 4px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

/* One grouped list per kind of speaker, like a phone's settings. */
.cast-sheet__panel {
  border: 1px solid var(--beacon-hairline);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}

.cast-sheet__available {
  border-radius: 0;
  padding-right: 6px;
}

.cast-sheet__available + .cast-sheet__available {
  border-top: 1px solid var(--beacon-hairline);
}

.cast-sheet__available:hover {
  background: none;
}

.cast-sheet__available :deep(.available__main) {
  min-height: 58px;
  padding: 8px 12px;
  gap: 14px;
  border-radius: 0;
}

.cast-sheet__available :deep(.available__main:active:not(:disabled)) {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

/* The kind of speaker in a small tile, the way a phone's settings mark a
 * row. */
.cast-sheet__available :deep(.available__icon) {
  box-sizing: content-box;
  padding: 8px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.07);
  color: rgba(var(--v-theme-on-surface), 0.75);
}

/* v-icon writes its 19px box inline; the AirPlay svg is 1em of a font
 * size it inherits. Both come out as a 35px tile. */
.cast-sheet__available :deep(svg.available__icon) {
  font-size: 19px;
}

.cast-sheet__available :deep(.available__add) {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.16);
  opacity: 1;
}

.cast-sheet__stream-info {
  margin-top: 22px;
  padding: 0 4px;
}

.cast-sheet__stop {
  margin-top: 20px;
}

@media (prefers-reduced-motion: reduce) {
  .cast-sheet {
    transition: none;
  }
}
</style>
