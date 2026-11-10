<template>
  <!-- Only where main picks the port: in dev, connect runs on its own
     - and its .env decides (portInfo.current is null there). -->
  <div v-if="portInfo && portInfo.current !== null" class="setting">
    <p class="setting__description">{{ $t('settings.fixedPortWhat') }}</p>
    <div class="connect-port__row">
      <v-text-field
        v-model="portInput"
        :label="$t('settings.fixedPort')"
        :placeholder="$t('settings.fixedPortPlaceholder')"
        :disabled="portInfo.fromEnvironment || busy"
        :error="invalid"
        type="number"
        inputmode="numeric"
        variant="solo-filled"
        hide-details
        class="connect-port__field"
        @keyup.enter="save"
      />
      <v-btn
        v-if="portInfo.port !== null && !portInfo.fromEnvironment"
        variant="text"
        :disabled="busy"
        @click="store(null)"
      >
        {{ $t('settings.fixedPortClear') }}
      </v-btn>
      <v-btn
        color="primary"
        :disabled="portInfo.fromEnvironment || busy || invalid || !changed"
        @click="save"
      >
        {{ $t('common.save') }}
      </v-btn>
    </div>
    <!-- A warning rather than the hint line: a fixed port that was taken
       - means anything relying on it cannot reach Beacon until the port is
       - freed and Beacon restarted. -->
    <v-alert
      v-if="taken"
      type="warning"
      variant="tonal"
      density="compact"
      class="settings-progress"
    >
      {{ $t('settings.fixedPortTaken', { port: portInfo.port, current: portInfo.current }) }}
    </v-alert>
    <p v-else class="setting__hint">{{ status }}</p>
    <!-- Home Assistant finds Beacon by its mDNS announcement and never needs
       - the address. Only setting it up by hand does, and that only holds
       - with a fixed port, so the address is shown with one. -->
    <p v-if="manualSetupHint" class="setting__hint">{{ manualSetupHint }}</p>
  </div>
</template>

<script lang="ts">
import { useRemoteControlStore } from '@/stores/remoteControl'

type ConnectPortInfo = Awaited<
  ReturnType<NonNullable<Window['api']>['appConfig']['getConnectPort']>
>

// Same range main accepts (main/index.ts): below 1024 needs root on
// Linux/macOS.
const MIN_PORT = 1024
const MAX_PORT = 65535

/**
 * The port main starts the backend on, so that an app reaching this desktop
 * from elsewhere on the network still finds it after a restart. Desktop only.
 */
export default {
  name: 'ConnectPortSetting',
  data() {
    return {
      portInfo: null as ConnectPortInfo | null,
      portInput: '' as string | number,
      busy: false,
    }
  },
  computed: {
    manualSetupHint(): string {
      const info = this.portInfo
      const lanIp = useRemoteControlStore().lanIp
      if (!info || info.port === null || info.port !== info.current || !lanIp) return ''
      return this.$t('settings.fixedPortManual', { address: lanIp, port: info.port })
    },
    /** null for an empty field, which means "a free port every start". */
    value(): number | null {
      const text = String(this.portInput).trim()
      return text === '' ? null : Number(text)
    },
    invalid(): boolean {
      const value = this.value
      return value !== null && !(Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT)
    },
    changed(): boolean {
      return this.value !== (this.portInfo?.port ?? null)
    },
    taken(): boolean {
      const info = this.portInfo
      return !!info && info.port !== null && info.current !== null && info.port !== info.current
    },
    status(): string {
      const info = this.portInfo
      if (!info || info.current === null) return ''
      if (info.fromEnvironment) {
        return this.$t('settings.fixedPortFromEnvironment', { port: info.port })
      }
      if (info.port === null) return this.$t('settings.fixedPortNone', { current: info.current })
      return this.$t('settings.fixedPortActive', { port: info.port })
    },
  },
  created() {
    if (window.api) void this.load()
  },
  methods: {
    async load() {
      try {
        this.portInfo = await window.api!.appConfig.getConnectPort()
        this.portInput = this.portInfo.port ?? ''
      } catch (error) {
        console.error('[settings] Failed to read the connect port:', error)
      }
    },
    async save() {
      if (this.invalid || !this.changed) return
      await this.store(this.value)
    },
    async store(port: number | null) {
      this.busy = true
      try {
        await window.api!.appConfig.setConnectPort(port)
        await this.load()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.fixedPort'),
          message: this.$t('settings.fixedPortSaved'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.fixedPort'),
          message: this.$t('settings.fixedPortFailed'),
        })
        console.error('[settings] Failed to store the connect port:', error)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped>
.connect-port__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.connect-port__field {
  flex: 1;
  min-width: 0;
}
</style>
