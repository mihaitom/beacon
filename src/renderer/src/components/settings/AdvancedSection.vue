<template>
  <!-- Shown only to an account the server lets change it
     - (capabilities.logLevelControl). With the old advanced-features switch
     - gone, this section is the log level alone, so for anyone else there
     - is nothing to show and no empty panel to show it in. -->
  <section v-if="authStore.capabilities.logLevelControl" class="settings-section">
    <h2 class="section-title">{{ $t('settings.advancedTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.logLevelHint') }}</p>
        <v-select
          v-model="logLevel"
          :items="logLevelOptions"
          :label="$t('settings.logLevel')"
          :loading="logLevelBusy"
          :disabled="logLevelBusy || logLevel === null"
          variant="solo-filled"
          hide-details
          @update:model-value="onLogLevelChange"
        />
      </div>

      <!-- Installation-wide, like the log level above and the API keys
         - below: the pairings live in connect, not in this browser, so
         - resetting them affects everyone using this Beacon. -->
      <div class="setting">
        <p class="setting__description">{{ $t('settings.resetAirplayHint') }}</p>
        <v-btn
          variant="tonal"
          prepend-icon="mdi-cast-off"
          :loading="resettingAirplay"
          @click="resetAirplayPairings"
        >
          {{ $t('settings.resetAirplay') }}
        </v-btn>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { getLogLevel, setLogLevel, type LogLevel } from '@/services/connect/logLevel'

/**
 * The backend's log verbosity and the AirPlay pairings, both
 * installation-wide.
 *
 * Settings used to hide the things that take setting up behind a "Show
 * advanced features" switch here; the Advanced tab is that hiding place
 * now, and it is shown only to a server administrator, so the switch is
 * gone. The log level answers to the media server's own admin flag
 * (capabilities.logLevelControl); the pairings are shared by everyone using
 * this Beacon, which is why resetting them belongs here too.
 */
export default {
  name: 'AdvancedSection',
  data() {
    return {
      logLevel: null as LogLevel | null,
      logLevelBusy: false,
      resettingAirplay: false,
    }
  },
  created() {
    // Skipped for an account that cannot see the control this feeds
    // (capabilities.logLevelControl) - no point asking connect for
    // something nobody here can act on.
    if (this.authStore.capabilities.logLevelControl) void this.loadLogLevel()
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    connectStore() {
      return useConnectStore()
    },
    logLevelOptions() {
      return [
        { title: this.$t('settings.logLevelTrace'), value: 'TRACE' },
        { title: this.$t('settings.logLevelDebug'), value: 'DEBUG' },
        { title: this.$t('settings.logLevelInfo'), value: 'INFO' },
        { title: this.$t('settings.logLevelWarning'), value: 'WARNING' },
        { title: this.$t('settings.logLevelError'), value: 'ERROR' },
      ]
    },
  },
  methods: {
    async loadLogLevel() {
      try {
        const { level } = await getLogLevel()
        this.logLevel = level
      } catch (error) {
        console.error('[settings] Failed to load log level:', error)
      }
    },
    async onLogLevelChange(value: LogLevel) {
      this.logLevelBusy = true
      try {
        await setLogLevel(value)
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChanged'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChangeFailed'),
        })
        console.error('[settings] Failed to set log level:', error)
        void this.loadLogLevel() // re-sync the dropdown with what's actually active
      } finally {
        this.logLevelBusy = false
      }
    },
    async resetAirplayPairings() {
      this.resettingAirplay = true
      try {
        await this.connectStore.unpairAll()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayReset'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayResetFailed'),
        })
        console.error('[settings] Failed to reset AirPlay pairings:', error)
      } finally {
        this.resettingAirplay = false
      }
    },
  },
}
</script>
