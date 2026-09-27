<template>
  <!-- Desktop only, like Remote Control itself: the key reaches this app's
     - playback through the same relay a phone does (see App.vue). -->
  <section v-if="isElectron" class="settings-section">
    <h2 class="section-title">{{ $t('settings.homeAutomationTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.homeAutomationWhat') }}</p>

        <div class="status-row">
          <span
            class="status-dot"
            :class="remoteControlStore.integration ? 'status-dot--ok' : 'status-dot--warn'"
          />
          <span class="setting__hint setting__hint--inline">
            {{
              remoteControlStore.integration
                ? $t('settings.homeAutomationKeyActive')
                : $t('settings.homeAutomationKeyMissing')
            }}
          </span>
        </div>

        <template v-if="newKey">
          <v-text-field
            :model-value="newKey"
            :label="$t('settings.homeAutomationKey')"
            readonly
            variant="solo-filled"
            density="compact"
            spellcheck="false"
            append-inner-icon="mdi-content-copy"
            hide-details
            class="home-automation__field"
            @click:append-inner="copy(newKey)"
          />
          <p class="setting__hint">{{ $t('settings.homeAutomationKeyOnce') }}</p>
        </template>

        <v-text-field
          v-if="remoteControlStore.integration && address"
          :model-value="address"
          :label="$t('remoteControl.address')"
          readonly
          variant="solo-filled"
          density="compact"
          append-inner-icon="mdi-content-copy"
          hide-details
          class="home-automation__field"
          @click:append-inner="copy(address)"
        />

        <div class="home-automation__actions">
          <v-btn
            variant="text"
            :href="DOCS_URL"
            target="_blank"
            rel="noopener noreferrer"
            append-icon="mdi-open-in-new"
          >
            {{ $t('settings.homeAutomationDocs') }}
          </v-btn>
          <v-btn
            v-if="remoteControlStore.integration"
            variant="text"
            :disabled="busy"
            @click="revokeKey"
          >
            {{ $t('settings.homeAutomationRevoke') }}
          </v-btn>
          <v-spacer />
          <v-btn color="primary" :loading="busy" :disabled="busy" @click="generateKey">
            {{
              remoteControlStore.integration
                ? $t('settings.homeAutomationRegenerate')
                : $t('settings.homeAutomationGenerate')
            }}
          </v-btn>
        </div>
      </div>

      <!-- Only where main picks the port: in dev, connect runs on its own
         - and its .env decides (portInfo.current is null there). -->
      <div v-if="portInfo && portInfo.current !== null" class="setting">
        <p class="setting__description">{{ $t('settings.fixedPortWhat') }}</p>
        <div class="home-automation__port-row">
          <v-text-field
            v-model="portInput"
            :label="$t('settings.fixedPort')"
            :placeholder="$t('settings.fixedPortPlaceholder')"
            :disabled="portInfo.fromEnvironment || portBusy"
            :error="portInvalid"
            type="number"
            inputmode="numeric"
            variant="solo-filled"
            hide-details
            class="home-automation__port-field"
            @keyup.enter="savePort"
          />
          <v-btn
            v-if="portInfo.port !== null && !portInfo.fromEnvironment"
            variant="text"
            :disabled="portBusy"
            @click="clearPort"
          >
            {{ $t('settings.fixedPortClear') }}
          </v-btn>
          <v-btn
            color="primary"
            :disabled="portInfo.fromEnvironment || portBusy || portInvalid || !portChanged"
            @click="savePort"
          >
            {{ $t('common.save') }}
          </v-btn>
        </div>
        <p class="setting__hint">{{ portStatus }}</p>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useRemoteControlStore } from '@/stores/remoteControl'

type ConnectPortInfo = Awaited<
  ReturnType<NonNullable<Window['api']>['appConfig']['getConnectPort']>
>

const DOCS_URL = 'https://github.com/mihaitom/beacon/blob/main/docs/home-automation.md'
// Same range main accepts (main/index.ts): below 1024 needs root on
// Linux/macOS.
const MIN_PORT = 1024
const MAX_PORT = 65535

/**
 * Access for Home Assistant and other automation: the integration key
 * (connect/core/integration_key.py), and the fixed port main starts the
 * backend on, so both survive a restart. A key also turns on the mDNS
 * announcement (connect/core/mdns.py), which is how Home Assistant finds
 * the port when the fixed one was taken.
 */
export default {
  name: 'HomeAutomationSection',
  data() {
    return {
      DOCS_URL,
      busy: false,
      /** Only right after generating: the key is never sent again. */
      newKey: '',
      portInfo: null as ConnectPortInfo | null,
      portInput: '' as string | number,
      portBusy: false,
    }
  },
  computed: {
    isElectron(): boolean {
      return !!window.api
    },
    remoteControlStore() {
      return useRemoteControlStore()
    },
    address(): string {
      const { lanIp, port } = this.remoteControlStore
      return lanIp && port ? `http://${lanIp}:${port}` : ''
    },
    /** null for an empty field, which means "a free port every start". */
    portValue(): number | null {
      const text = String(this.portInput).trim()
      return text === '' ? null : Number(text)
    },
    portInvalid(): boolean {
      const value = this.portValue
      return value !== null && !(Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT)
    },
    portChanged(): boolean {
      return this.portValue !== (this.portInfo?.port ?? null)
    },
    portStatus(): string {
      const info = this.portInfo
      if (!info || info.current === null) return ''
      if (info.fromEnvironment) {
        return this.$t('settings.fixedPortFromEnvironment', { port: info.port })
      }
      if (info.port === null) return this.$t('settings.fixedPortNone', { current: info.current })
      if (info.port !== info.current) {
        return this.$t('settings.fixedPortTaken', { port: info.port, current: info.current })
      }
      return this.$t('settings.fixedPortActive', { port: info.port })
    },
  },
  created() {
    if (this.isElectron) void this.loadPort()
  },
  methods: {
    async loadPort() {
      try {
        this.portInfo = await window.api!.appConfig.getConnectPort()
        this.portInput = this.portInfo.port ?? ''
      } catch (error) {
        console.error('[settings] Failed to read the connect port:', error)
      }
    },
    async generateKey() {
      this.busy = true
      try {
        this.newKey = await this.remoteControlStore.generateIntegrationKey()
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async revokeKey() {
      this.busy = true
      try {
        await this.remoteControlStore.revokeIntegrationKey()
        this.newKey = ''
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async savePort() {
      if (this.portInvalid || !this.portChanged) return
      await this.storePort(this.portValue)
    },
    async clearPort() {
      await this.storePort(null)
    },
    async storePort(port: number | null) {
      this.portBusy = true
      try {
        await window.api!.appConfig.setConnectPort(port)
        await this.loadPort()
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
        this.portBusy = false
      }
    },
    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text)
      } catch (error) {
        console.error('[settings] Failed to copy:', error)
      }
    },
    toastError(error: unknown) {
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('settings.homeAutomationTitle'),
        message: this.$t('settings.homeAutomationFailed'),
      })
      console.error('[settings] Integration key request failed:', error)
    },
  },
}
</script>

<style scoped>
.home-automation__field {
  margin-top: 12px;
}

.home-automation__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.home-automation__port-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.home-automation__port-field {
  flex: 1;
  min-width: 0;
}
</style>
