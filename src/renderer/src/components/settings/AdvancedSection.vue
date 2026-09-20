<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.advancedTitle') }}</h2>
    <div class="beacon-panel">
      <!-- The switch is always here, and off by default. Whoever set the
       - music server up goes looking for this; everyone else in the
       - household never has to meet what it uncovers. See
       - stores/advancedMode.ts. -->
      <div class="setting">
        <v-switch
          :model-value="advancedModeStore.enabled"
          color="primary"
          density="compact"
          hide-details
          :label="$t('settings.advancedMode')"
          @update:model-value="advancedModeStore.setEnabled(!!$event)"
        />
        <p class="setting__hint">{{ $t('settings.advancedModeHint') }}</p>
      </div>

      <!-- Not behind the switch: it was here before it existed, and it
       - already answers to the media server's own admin flag. See
       - services/capabilities.ts's logLevelControl. -->
      <div v-if="authStore.capabilities.logLevelControl" class="setting">
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
    </div>
  </section>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useAdvancedModeStore } from '@/stores/advancedMode'
import { getLogLevel, setLogLevel, type LogLevel } from '@/services/connect/logLevel'

/**
 * The switch that uncovers the things which have to be set up before they
 * work, and the backend's log verbosity.
 *
 * The switch is always here and off by default: whoever runs the music
 * server comes looking for it, and everyone else in the household never
 * meets what it reveals. The log level is not behind it - it predates the
 * switch and already answers to the media server's own admin flag.
 */
export default {
  name: 'AdvancedSection',
  data() {
    return {
      logLevel: null as LogLevel | null,
      logLevelBusy: false,
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
    advancedModeStore() {
      return useAdvancedModeStore()
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
  },
}
</script>
