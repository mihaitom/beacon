<template>
  <!-- Desktop only, like Remote Control itself: the key reaches this app's
     - playback through the same relay a phone does (see App.vue). -->
  <section v-if="isElectron" class="settings-section">
    <h2 class="section-title">{{ $t('settings.homeAutomationTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <v-alert type="info" variant="tonal" density="compact" class="home-automation__retiring">
          {{ $t('settings.homeAutomationRetiring') }}
        </v-alert>
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
            @click="$emitter.emit('openHelp', 'guides/home-automation')"
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
    </div>
  </section>
</template>

<script lang="ts">
import { useRemoteControlStore } from '@/stores/remoteControl'

/**
 * The retired integration key (connect/core/integration_key.py), kept
 * working until a later release removes it: Home Assistant now uses a key
 * from Apps and devices (DeviceKeysSection.vue). A key also turns on the mDNS
 * announcement (connect/core/mdns.py).
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
    }
  },
  computed: {
    isElectron(): boolean {
      return !!window.api
    },
    remoteControlStore() {
      return useRemoteControlStore()
    },
  },
  beforeUnmount() {
    clearTimeout(this.keyCopiedTimer)
  },
  methods: {
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

.home-automation__retiring {
  margin-bottom: 12px;
}
</style>
