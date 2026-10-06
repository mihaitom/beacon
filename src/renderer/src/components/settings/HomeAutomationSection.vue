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
            hide-details
            class="home-automation__field"
          >
            <!-- The checkmark for a moment, like the other copy buttons in
             - the app - a toast is too much for something this small. -->
            <template #append-inner>
              <v-icon
                :icon="keyCopied ? 'mdi-check' : 'mdi-content-copy'"
                :color="keyCopied ? 'success' : undefined"
                :title="
                  keyCopied
                    ? $t('settings.homeAutomationKeyCopied')
                    : $t('settings.homeAutomationCopyKey')
                "
                @click="copy(newKey)"
              />
            </template>
          </v-text-field>
          <p class="setting__hint">{{ $t('settings.homeAutomationKeyOnce') }}</p>
        </template>

        <div class="home-automation__actions">
          <v-btn
            variant="text"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'home-automation')"
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
        <!-- A warning rather than the hint line: a fixed port that was
           - taken means anything relying on it cannot reach Beacon until the
           - port is freed and Beacon restarted. -->
        <v-alert
          v-if="portTaken"
          type="warning"
          variant="tonal"
          density="compact"
          class="settings-progress"
        >
          {{ $t('settings.fixedPortTaken', { port: portInfo.port, current: portInfo.current }) }}
        </v-alert>
        <p v-else class="setting__hint">{{ portStatus }}</p>
        <!-- Home Assistant finds Beacon by its mDNS announcement and never
           - needs the address. Only setting it up by hand does, and that
           - only holds with a fixed port, so the address is shown with one. -->
        <p v-if="manualSetupHint" class="setting__hint">{{ manualSetupHint }}</p>
      </div>
    </div>
  </section>
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
 * Access for Home Assistant and other automation: the integration key
 * (connect/core/integration_key.py), and the fixed port main starts the
 * backend on, so both survive a restart. A key also turns on the mDNS
 * announcement (connect/core/mdns.py), which is how Home Assistant finds
 * Beacon at all - the fixed port is for where that announcement does not
 * reach.
 */
export default {
  name: 'HomeAutomationSection',
  data() {
    return {
      busy: false,
      /** Only right after generating: the key is never sent again. */
      newKey: '',
      keyCopied: false,
      keyCopiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
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
    manualSetupHint(): string {
      const info = this.portInfo
      const lanIp = this.remoteControlStore.lanIp
      if (!info || info.port === null || info.port !== info.current || !lanIp) return ''
      return this.$t('settings.fixedPortManual', { address: lanIp, port: info.port })
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
    portTaken(): boolean {
      const info = this.portInfo
      return !!info && info.port !== null && info.current !== null && info.port !== info.current
    },
    portStatus(): string {
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
    if (this.isElectron) void this.loadPort()
  },
  beforeUnmount() {
    clearTimeout(this.keyCopiedTimer)
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
        return
      }
      clearTimeout(this.keyCopiedTimer)
      this.keyCopied = true
      this.keyCopiedTimer = setTimeout(() => {
        this.keyCopied = false
      }, 2000)
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
