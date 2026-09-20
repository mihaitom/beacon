<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.lastfmTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.lastfmWhat') }}</p>

        <div class="status-row">
          <span
            class="status-dot"
            :class="lastfmStore.configured ? 'status-dot--ok' : 'status-dot--warn'"
          />
          <span class="setting__hint setting__hint--inline">{{ lastfmKeyStatus }}</span>
        </div>

        <div class="lastfm-key-row">
          <v-text-field
            v-model="lastfmKey"
            :label="$t('settings.lastfmKey')"
            :placeholder="lastfmKeyPlaceholder"
            :loading="lastfmKeyBusy"
            :disabled="lastfmKeyBusy"
            variant="solo-filled"
            autocomplete="off"
            spellcheck="false"
            hide-details
            class="lastfm-key-row__field"
            @keyup.enter="saveLastfmKey"
          />
          <!-- The how-to-get-one steps behind an info button rather than
           - as a paragraph under the field: five lines that stop being
           - interesting the moment somebody has a key, and a permanent
           - block of them pushes the rest of the page down for everyone
           - who already does. See the styleguide, "Advice on a setting". -->
          <quality-tips :lines="lastfmKeySteps" />
        </div>

        <div class="lastfm-key-actions">
          <v-btn
            variant="text"
            :href="LASTFM_API_ACCOUNT_URL"
            target="_blank"
            rel="noopener noreferrer"
            append-icon="mdi-open-in-new"
          >
            {{ $t('settings.lastfmKeyGet') }}
          </v-btn>
          <v-btn
            v-if="lastfmStore.configured && !lastfmFromEnvironment"
            variant="text"
            :disabled="lastfmKeyBusy"
            @click="clearLastfmKey"
          >
            {{ $t('settings.lastfmKeyClear') }}
          </v-btn>
          <v-spacer />
          <v-btn
            variant="tonal"
            :disabled="lastfmKeyBusy || !lastfmKey.trim()"
            @click="saveLastfmKey"
          >
            {{ $t('common.save') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useLastfmStore } from '@/stores/lastfm'
import { getLastfmStatus, setLastfmApiKey } from '@/services/connect/lastfm'
import QualityTips from './QualityTips.vue'
// Where a key is requested. Opened from the button next to the field, so
// nobody has to copy it out of a tooltip by hand.
const LASTFM_API_ACCOUNT_URL = 'https://www.last.fm/api/account/create'

/**
 * The installation-wide Last.fm application key, and what it unlocks.
 *
 * A section of its own rather than one more row under "Advanced": this is
 * a service being connected, with its own status and its own way in.
 * SettingsView decides whether to render it at all (advanced features).
 */
export default {
  name: 'LastfmSection',
  components: { QualityTips },
  data() {
    return {
      LASTFM_API_ACCOUNT_URL,
      lastfmKey: '',
      lastfmKeyBusy: false,
      lastfmFromEnvironment: false,
    }
  },
  computed: {
    lastfmStore() {
      return useLastfmStore()
    },
    lastfmKeySteps(): string[] {
      return [
        this.$t('settings.lastfmStep1'),
        this.$t('settings.lastfmStep2'),
        this.$t('settings.lastfmStep3'),
        this.$t('settings.lastfmStep4'),
      ]
    },
    lastfmKeyPlaceholder(): string {
      return this.lastfmStore.configured
        ? this.$t('settings.lastfmKeySet')
        : this.$t('settings.lastfmKeyPlaceholder')
    },
    lastfmKeyStatus(): string {
      if (!this.lastfmStore.configured) return this.$t('settings.lastfmKeyMissing')
      return this.lastfmFromEnvironment
        ? this.$t('settings.lastfmKeyFromEnvironment')
        : this.$t('settings.lastfmKeyStored')
    },
  },
  created() {
    void this.loadLastfmStatus()
  },
  methods: {
    async loadLastfmStatus() {
      try {
        const status = await getLastfmStatus()
        this.lastfmStore.configured = status.configured
        this.lastfmFromEnvironment = status.fromEnvironment
      } catch (error) {
        console.error('[settings] Failed to load Last.fm status:', error)
      }
    },
    async saveLastfmKey() {
      const key = this.lastfmKey.trim()
      if (!key) return
      await this.applyLastfmKey(key, this.$t('settings.lastfmKeySaved'))
    },
    async clearLastfmKey() {
      await this.applyLastfmKey('', this.$t('settings.lastfmKeyCleared'))
    },
    async applyLastfmKey(key: string, successMessage: string) {
      this.lastfmKeyBusy = true
      try {
        const status = await setLastfmApiKey(key)
        this.lastfmStore.configured = status.configured
        this.lastfmFromEnvironment = status.fromEnvironment
        this.lastfmKey = ''
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.lastfmKey'),
          message: successMessage,
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.lastfmKey'),
          message: this.$t('settings.lastfmKeyFailed'),
        })
        console.error('[settings] Failed to store the Last.fm key:', error)
      } finally {
        this.lastfmKeyBusy = false
      }
    },
  },
}
</script>

<style scoped>
.lastfm-key-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
}

.lastfm-key-row__field {
  flex: 1;
  min-width: 0;
}

.lastfm-key-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
