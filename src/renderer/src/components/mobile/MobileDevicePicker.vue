<template>
  <v-bottom-sheet
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="mobile-device-picker">
      <div class="mobile-device-picker__header">
        <span class="text-body-large">{{ $t('mobile.playOn') }}</span>
        <v-spacer />
        <!-- Icon-only, unlike ConnectDevicePicker.vue's labelled button:
         - the header already carries "Done", and two text buttons side by
         - side on a phone read as two equally weighted choices when only
         - one of them closes the sheet. Its own spinner matters more here
         - than on desktop, since the centred one below only appears while
         - there is nothing in the list yet. -->
        <v-btn
          class="mobile-device-picker__rescan"
          variant="text"
          size="small"
          icon="mdi-refresh"
          density="comfortable"
          :aria-label="$t('connect.rescan')"
          :loading="connectStore.isScanning"
          :disabled="connectStore.isScanning"
          @click="connectStore.refreshDevices(true)"
        />
        <!-- Every action the sheet has lives in this one row: rescan,
         - stop, done. The list below is only ever destinations. -->
        <v-btn
          v-if="connectStore.isActive"
          variant="text"
          size="small"
          color="error"
          @click="disconnectAll"
        >
          {{ $t('connect.stopAll') }}
        </v-btn>
        <v-btn
          class="mobile-device-picker__done"
          variant="flat"
          size="small"
          :color="selectedKeys.size > 0 ? 'primary' : undefined"
          @click="done"
        >
          {{ $t('common.done') }}
        </v-btn>
      </div>

      <!-- The same three notices ConnectDevicePicker.vue shows above its
       - list. They were missing here entirely, so a phone got a sheet that
       - simply stayed empty where the desktop said why. -->
      <connect-error-banner
        v-if="connectStore.errors.apiUnreachable"
        variant="api-unreachable"
        class="mobile-device-picker__notice"
        @retry="connectStore.refreshDevices(true)"
      />
      <connect-error-banner
        v-if="authStore.health?.ffmpeg === false"
        variant="ffmpeg-missing"
        class="mobile-device-picker__notice"
      />
      <v-alert
        v-if="connectStore.errors.message"
        type="error"
        variant="tonal"
        density="compact"
        closable
        class="mobile-device-picker__notice"
        @click:close="connectStore.clearError()"
      >
        {{ connectStore.errors.message }}
        <div v-if="connectStore.errors.detail" class="connect-error-detail">
          {{ connectStore.errors.detail }}
        </div>
      </v-alert>

      <div
        v-if="connectStore.isScanning && allDevices.length === 0"
        class="mobile-device-picker__scanning"
      >
        <v-progress-circular indeterminate color="primary" />
      </div>

      <v-list v-else class="mobile-device-picker__list">
        <!-- Local playback as one destination among the speakers, not as
         - a red "stop" action sitting beside them. There used to be two
         - rows here, "Stop all" and "This device", firing the identical
         - command — one list of places the sound can go, with the current
         - one ticked, is a choice; two differently coloured rows doing the
         - same thing is a puzzle. Matches ConnectDevicePicker.vue, which
         - has always shown local playback as an entry with its own active
         - state, and keeps "Stop all" as an action next to Done rather
         - than inside the list. -->
        <v-list-item class="mobile-device-picker__local" @click="playHere">
          <template #prepend>
            <v-icon
              :icon="connectStore.isActive ? 'mdi-speaker' : 'mdi-circle-slice-8'"
              :color="connectStore.isActive ? undefined : 'primary'"
            />
          </template>
          <v-list-item-title>{{ $t('connect.thisDevice') }}</v-list-item-title>
          <template v-if="!connectStore.isActive" #append>
            <v-icon icon="mdi-check-circle" color="primary" />
          </template>
        </v-list-item>

        <template v-for="group in deviceGroups" :key="group.type">
          <v-list-subheader>{{ group.label }}</v-list-subheader>
          <mobile-device-row
            v-for="entry in group.entries"
            :key="`${entry.type}:${entry.device.name}`"
            :device="entry.device"
            :type="entry.type"
            :selected="selectedKeys.has(`${entry.type}:${entry.device.name}`)"
            @toggle="toggle(entry)"
            @take-over="takeOver(entry)"
          />
        </template>

        <div
          v-if="allDevices.length === 0 && !connectStore.isScanning"
          class="text-body-medium text-medium-emphasis mobile-device-picker__empty"
        >
          {{ $t('connect.noDevicesFound') }}
        </div>
      </v-list>

      <!-- What is playing and how it is being sent, the same section the
       - desktop picker ends with. Inside the sheet rather than in the
       - player bar: this is the one surface on a phone where the cast
       - destination is being decided, which is when the format matters. -->
      <template v-if="showStreamInfo">
        <v-divider class="mobile-device-picker__rule" />
        <stream-info-section class="mobile-device-picker__stream-info" />
      </template>
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import ConnectErrorBanner from '@/components/connect/ConnectErrorBanner.vue'
import StreamInfoSection, { hasStreamInfo } from '@/components/connect/StreamInfoSection.vue'
import MobileDeviceRow from './MobileDeviceRow.vue'
import type { DeviceType, DiscoveredDevice } from '@/services/connect/types'

interface DeviceEntry {
  device: DiscoveredDevice
  type: DeviceType
}

interface DeviceGroup {
  type: DeviceType
  label: string
  entries: DeviceEntry[]
}

// Same fixed order/labels as ConnectDevicePicker.vue — keeps "which icon
// means which brand" and the group order reading the same on both surfaces.
const TYPE_ORDER: DeviceType[] = ['sonos', 'airplay', 'chromecast', 'dlna']
const TYPE_LABELS: Record<DeviceType, string> = {
  sonos: 'Sonos',
  airplay: 'AirPlay',
  chromecast: 'Chromecast',
  dlna: 'DLNA',
}

export default {
  name: 'MobileDevicePicker',
  components: { ConnectErrorBanner, MobileDeviceRow, StreamInfoSection },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      // Pre-checked with whatever's already casting, same starting point as
      // DeviceListItem.vue's own `checked` computed. Snapshotted separately
      // as initialKeys so "Done" can tell a genuinely unchanged selection
      // apart from a re-confirmed one — see selectionUnchanged() below and
      // the LAN remote's devices.js, which validated this exact behavior
      // ("Wenn keine Änderung ist, dann soll done nur das overlay
      // schließen.").
      selectedKeys: new Set<string>(),
      initialKeys: new Set<string>(),
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    authStore() {
      return useAuthStore()
    },
    // Whether stream-info-section renders anything at all — see
    // hasStreamInfo() in StreamInfoSection.vue, the same gate the desktop
    // picker's own divider uses.
    showStreamInfo(): boolean {
      return hasStreamInfo()
    },
    activeKeys(): string[] {
      return this.connectStore.activeTargets.map(
        (t: { name: string; type: string }) => `${t.type}:${t.name}`,
      )
    },
    /** Whether what's ticked still matches what was last seeded from
     * reality. Drives two things: "Done" on an untouched sheet just closes
     * it (validated against the LAN remote's devices.js — "Wenn keine
     * Änderung ist, dann soll done nur das overlay schließen."), and the
     * watcher below only re-seeds while this is true, so a live change
     * never discards a selection someone is in the middle of making. Same
     * split ConnectDevicePicker.vue makes between userHasEdited and
     * hasPendingChanges. */
    selectionUnchanged(): boolean {
      return (
        this.selectedKeys.size === this.initialKeys.size &&
        [...this.selectedKeys].every((key) => this.initialKeys.has(key))
      )
    },
    deviceGroups(): DeviceGroup[] {
      const d = this.connectStore.devices
      const byType: Record<DeviceType, DiscoveredDevice[]> = {
        sonos: d.sonos,
        airplay: d.airplay,
        chromecast: d.chromecast,
        dlna: d.dlna,
      }
      return TYPE_ORDER.map((type) => ({
        type,
        label: TYPE_LABELS[type],
        entries: [...byType[type]]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((device) => ({ device, type })),
      })).filter((group) => group.entries.length > 0)
    },
    allDevices(): DeviceEntry[] {
      return this.deviceGroups.flatMap((group) => group.entries)
    },
  },
  watch: {
    // immediate, so a sheet that is already open when it mounts seeds too
    // — the sheet is normally mounted closed and toggled, but relying on
    // that leaves the ticks empty in every other case.
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (!open) return
        void this.connectStore.refreshDevices()
        this.seedFromActiveTargets()
      },
    },
    // Keeps an open sheet honest about what is actually casting — another
    // client taking a device, one dropping off the network, or this
    // sheet's own "Take over" landing. Without it the sheet only ever
    // seeded on open, so anything happening afterwards left the ticks
    // describing a target set that no longer existed, and "Done" then
    // applied that stale set as if it were the user's intent. Skipped
    // while the selection has been edited, so it never overwrites an
    // in-progress choice.
    activeKeys() {
      if (!this.modelValue || !this.selectionUnchanged) return
      this.seedFromActiveTargets()
    },
  },
  methods: {
    key(entry: DeviceEntry): string {
      return `${entry.type}:${entry.device.name}`
    },
    seedFromActiveTargets() {
      this.selectedKeys = new Set(this.activeKeys)
      this.initialKeys = new Set(this.activeKeys)
    },
    toggle(entry: DeviceEntry) {
      const key = this.key(entry)
      const next = new Set(this.selectedKeys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      this.selectedKeys = next
    },
    // Releases every active cast target — local playback then picks up on
    // its own (see stores/playback.ts's connect.$subscribe handler). The
    // "Stop all" action in the header and picking "This device" below are
    // the same call; they differ only in where they are offered, which is
    // why the list no longer carries both.
    disconnectAll() {
      void this.connectStore.stopAll()
      this.$emit('update:modelValue', false)
    },
    /** Picking local playback. Already local means there is nothing to
     * apply — the sheet just closes, rather than firing a stop at nothing
     * (which would still re-dispatch through the whole cast teardown). */
    playHere() {
      if (!this.connectStore.isActive) {
        this.$emit('update:modelValue', false)
        return
      }
      this.disconnectAll()
    },
    // Mirrors ConnectDevicePicker.vue's own takeOver() — immediate,
    // forced, and deliberately doesn't close the sheet (the row's own
    // state flips once activeTargets updates, same as desktop's
    // hover-button doesn't close its popover either). Adds to the active
    // targets rather than replacing them: a claimed row's tap is inert
    // (MobileDeviceRow.vue's onRowClick()), so this button is the only way
    // to pick such a device, and it must not be the only way to lose every
    // other speaker at the same time.
    async takeOver(entry: DeviceEntry) {
      const target = { type: entry.type, name: entry.device.name }
      try {
        await usePlaybackStore().applyTargets([...this.connectStore.activeTargets, target], true)
        // Ticks the row itself: an unedited sheet re-seeds from the new
        // targets via the watcher above, but an edited one deliberately
        // doesn't, and this device is applied either way.
        const key = this.key(entry)
        this.selectedKeys = new Set(this.selectedKeys).add(key)
        this.initialKeys = new Set(this.initialKeys).add(key)
      } catch {
        this.reportError()
      }
    },
    async done() {
      if (!this.selectionUnchanged) {
        const targets = [...this.selectedKeys].map((key) => {
          const [deviceType, ...rest] = key.split(':')
          return { type: deviceType as DeviceType, name: rest.join(':') }
        })
        try {
          // applyTargets(), not castTo(): this picker already collected a
          // desired *end state*, and castTo() would re-dispatch every
          // device in it, including ones already playing. See its own
          // docstring.
          await usePlaybackStore().applyTargets(targets)
        } catch {
          // Stays open on failure, so the selection is still there to
          // retry from — the error itself is shown by the alert at the top
          // of the sheet, the same one the desktop picker has.
          this.reportError()
          return
        }
        // A conflict left the takeover dialog open (MobileLayout.vue
        // mounts one) — closing the sheet out from under it would hide
        // which device the question is about.
        if (this.connectStore.pendingTakeover) return
      }
      this.$emit('update:modelValue', false)
    },
    /** Surfaces whatever the store just recorded — the desktop picker
     * renders connectStore.errors inline, this sheet has nowhere to put
     * them, so they go to the same toast every other mobile failure uses. */
    reportError() {
      // Only where the sheet's own alert has nothing to show. A failure
      // normally leaves a message on the store, and that is what the alert
      // at the top renders - toasting it as well would report one failure
      // twice, in two places, on a screen this size.
      if (this.connectStore.errors.message) return
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('connect.title'),
        message: this.$t('connect.unknownError'),
      })
    },
  },
}
</script>

<style scoped>
.mobile-device-picker__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 16px 16px 8px;
}

.mobile-device-picker__notice {
  margin: 0 16px 12px;
}

/* The section brings its own vertical rhythm; this only insets it to the
 * sheet's own margin and keeps it off the safe-area edge. */
.mobile-device-picker__rule {
  margin-top: 4px;
}

.mobile-device-picker__stream-info {
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
}

.mobile-device-picker__rescan {
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.mobile-device-picker__scanning {
  display: flex;
  justify-content: center;
  padding: 24px;
}

/* The row reads as the selected destination when nothing is casting —
 * same treatment a picked speaker gets (MobileDeviceRow.vue's own
 * check-circle), so the list has one consistent way of saying "this is
 * where the sound is going". */
.mobile-device-picker__local :deep(.v-list-item-title) {
  font-weight: 500;
}

.mobile-device-picker__list {
  max-height: 60vh;
  overflow-y: auto;
  padding-bottom: env(safe-area-inset-bottom);
}

/* The "no speakers found" line, given the padding a row would have. */
.mobile-device-picker__empty {
  padding: 16px;
}
</style>
