<template>
  <v-card class="connect-picker">
    <header class="connect-picker__head">
      <v-icon
        :icon="connectStore.isActive ? 'mdi-cast-connected' : 'mdi-cast'"
        :color="connectStore.isActive ? 'primary' : undefined"
        size="20"
        :class="{ 'connect-picker__active-glow': connectStore.isActive }"
      />
      <span class="connect-picker__title">{{ $t('connect.playingOn') }}</span>
    </header>

    <div v-if="hasNotices" class="connect-picker__notices">
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
        <div v-if="connectStore.errors.detail" class="connect-error-detail">
          {{ connectStore.errors.detail }}
        </div>
      </v-alert>
    </div>

    <!-- Two halves: what is playing, with its volumes, and what could be
     - added. The menu's height follows the speakers in use rather than
     - every one the network has. -->
    <div class="connect-picker__body">
      <section class="connect-picker__playing">
        <div v-if="connectStore.isActive" class="eyebrow-label connect-picker__heading">
          {{ playingHeading }}
        </div>
        <segmented-control
          v-if="showModeSwitch"
          class="connect-picker__mode"
          dense
          :model-value="groupVolumeStore.mode"
          :options="modeOptions"
          :label="$t('connect.groupVolume')"
          @update:model-value="onModeChange"
        />

        <template v-if="connectStore.isActive">
          <volume-fader
            v-if="volumeGroup"
            master
            class="connect-picker__fader"
            :label="$t('connect.allSpeakers')"
            :model-value="groupVolumeLevel"
            :floor="groupVolumeStore.mode === 'relative' ? groupVolumeFloor : null"
            @update:model-value="onMasterChange"
            @start="volumeGroup.forEach(startVolumeDrag)"
            @end="volumeGroup.forEach(endVolumeDrag)"
          >
            <template #icon><v-icon icon="mdi-speaker-multiple" size="20" /></template>
          </volume-fader>
          <volume-fader
            v-for="target in connectStore.activeTargets"
            :key="`${target.type}:${target.name}`"
            class="connect-picker__fader"
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
          <button type="button" class="connect-picker__local" @click="playHere">
            <v-icon icon="mdi-laptop" size="19" />
            {{ $t('connect.playHereInstead') }}
          </button>
        </template>
        <div v-else class="connect-picker__here">
          <v-icon icon="mdi-laptop" size="20" color="primary" />
          <span class="text-body-medium">{{ $t('connect.thisDevice') }}</span>
        </div>

        <stream-info-section class="connect-picker__stream-info" />
      </section>

      <section class="connect-picker__available">
        <div class="eyebrow-label connect-picker__heading">{{ $t('connect.addHeading') }}</div>
        <!-- No separate progress bar: the rescan button below carries the
         - spinner, and this line is the only place an empty list needs to
         - say anything at all. It covers the first scan after login too,
         - which blocks for the full sweep (see refreshDevices()). -->
        <div v-if="availableGroups.length === 0" class="text-body-small connect-picker__empty">
          {{ emptyAvailableText }}
        </div>
        <template v-for="group in availableGroups" :key="group.type">
          <div class="text-body-small connect-picker__type">{{ group.label }}</div>
          <available-device-row
            v-for="entry in group.entries"
            :key="`${entry.type}:${entry.device.name}`"
            :device="entry.device"
            :type="entry.type"
            :busy="busyKey === `${entry.type}:${entry.device.name}`"
            @add="add(entry)"
            @take-over="takeOver(entry)"
            @pair="openPairing(entry.device.name)"
          />
        </template>
      </section>
    </div>

    <footer class="connect-picker__actions">
      <v-btn
        class="connect-picker__rescan"
        size="small"
        variant="text"
        :loading="connectStore.isScanning"
        :disabled="connectStore.isScanning"
        @click="connectStore.refreshDevices(true)"
      >
        {{ $t('connect.rescan') }}
      </v-btn>
      <v-spacer />
      <v-btn
        v-if="connectStore.isActive"
        size="small"
        variant="text"
        color="error"
        @click="stopAll"
      >
        {{ $t('connect.stopAll') }}
      </v-btn>
    </footer>

    <airplay-pairing-dialog v-model="pairingOpen" :device-name="pairingDeviceName" />
  </v-card>
</template>

<script lang="ts">
import SegmentedControl from '@/components/SegmentedControl.vue'
import ConnectErrorBanner from './ConnectErrorBanner.vue'
import AirplayPairingDialog from './AirplayPairingDialog.vue'
import AirplayIcon from './AirplayIcon.vue'
import AvailableDeviceRow from './AvailableDeviceRow.vue'
import VolumeFader from './VolumeFader.vue'
import StreamInfoSection from './StreamInfoSection.vue'
import { castMenuMixin } from './castMenuMixin'

/** The desktop's cast menu: what is playing on the left, what could be
 * added on the right. What it does lives in castMenuMixin, shared with the
 * phone's sheet. */
export default {
  name: 'ConnectDevicePicker',
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
}
</script>

<style scoped>
.connect-picker {
  /* Two columns want room; a narrow window still gets the whole menu,
   * stacked (see the container query below). */
  width: min(800px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  max-height: inherit;
  border: 1px solid var(--beacon-hairline);
  container-type: inline-size;
}

.connect-picker__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px 10px;
}

.connect-picker__title {
  font-size: 1rem;
  font-weight: 600;
}

.connect-picker__active-glow {
  filter: drop-shadow(0 0 6px rgba(var(--v-theme-primary), 0.55));
}

.connect-picker__notices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 14px 8px;
}

.connect-error-detail {
  margin-top: 4px;
  font-size: 0.75rem;
  opacity: 0.7;
  word-break: break-word;
}

.connect-picker__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  min-height: 0;
  flex: 1;
}

.connect-picker__playing,
.connect-picker__available {
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 10px;
}

.connect-picker__playing {
  display: flex;
  flex-direction: column;
  padding-inline: 10px;
}

.connect-picker__available {
  padding-inline: 8px;
  border-left: 1px solid var(--beacon-hairline);
  background: rgba(0, 0, 0, 0.12);
}

.connect-picker__heading {
  padding: 10px 8px 8px;
}

/* Local playback, playing: lit the way a speaker's row is. */
.connect-picker__here {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  margin-top: 8px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-primary), 0.08);
  font-weight: 500;
}

.connect-picker__here::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px 1px rgba(var(--v-theme-primary), 0.55);
}

.connect-picker__mode {
  margin: 0 0 8px;
}

.connect-picker__fader {
  margin-bottom: 4px;
}

.connect-picker__fader.fader--master {
  margin-bottom: 8px;
}

.connect-picker__local {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 42px;
  margin-top: 4px;
  padding: 0 12px;
  border-radius: 10px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  text-align: left;
}

.connect-picker__local:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.connect-picker__local:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

/* At the foot of its half, under however many speakers there are. */
.connect-picker__stream-info {
  margin-top: auto;
  padding: 16px 8px 0;
}

.connect-picker__type {
  padding: 10px 8px 4px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.connect-picker__empty {
  padding: 4px 8px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.connect-picker__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-top: 1px solid var(--beacon-hairline);
}

@container (max-width: 620px) {
  .connect-picker__body {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }

  .connect-picker__playing,
  .connect-picker__available {
    overflow: visible;
  }

  .connect-picker__available {
    border-left: none;
    border-top: 1px solid var(--beacon-hairline);
  }
}
</style>
