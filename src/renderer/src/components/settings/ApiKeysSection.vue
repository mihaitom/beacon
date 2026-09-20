<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.apiKeysTitle') }}</h2>
    <div v-for="service in services" :key="service.id" class="beacon-panel api-key-panel">
      <div class="setting">
        <p class="setting__description">{{ service.what }}</p>

        <div class="status-row">
          <span
            class="status-dot"
            :class="statusFor(service.id).configured ? 'status-dot--ok' : 'status-dot--warn'"
          />
          <span class="setting__hint setting__hint--inline">{{ statusText(service.id) }}</span>
        </div>

        <div class="api-key-row">
          <v-text-field
            v-model="keyInput[service.id]"
            :label="$t('settings.apiKeyLabel', { service: service.name })"
            :placeholder="
              statusFor(service.id).configured
                ? $t('settings.apiKeySet')
                : $t('settings.apiKeyPlaceholder')
            "
            :loading="busy[service.id]"
            :disabled="busy[service.id]"
            variant="solo-filled"
            autocomplete="off"
            spellcheck="false"
            hide-details
            class="api-key-row__field"
            @keyup.enter="saveKey(service.id)"
          />
          <!-- The how-to-get-one steps behind an info button rather than as
           - a paragraph under the field: a few lines that stop being
           - interesting the moment somebody has a key, and a permanent block
           - of them pushes the rest of the page down for everyone who
           - already does. See the styleguide, "Advice on a setting". -->
          <quality-tips :lines="service.steps" />
        </div>

        <div class="api-key-actions">
          <v-btn
            variant="text"
            :href="service.getUrl"
            target="_blank"
            rel="noopener noreferrer"
            append-icon="mdi-open-in-new"
          >
            {{ $t('settings.apiKeyGet') }}
          </v-btn>
          <!-- Removing a key that comes from the deployment would do
           - nothing - the environment's key stays in effect - so the
           - button would look broken. -->
          <v-btn
            v-if="statusFor(service.id).configured && !statusFor(service.id).fromEnvironment"
            variant="text"
            :disabled="busy[service.id]"
            @click="clearKey(service.id)"
          >
            {{ $t('settings.apiKeyClear') }}
          </v-btn>
          <v-spacer />
          <v-btn
            variant="tonal"
            :disabled="busy[service.id] || !keyInput[service.id].trim()"
            @click="saveKey(service.id)"
          >
            {{ $t('common.save') }}
          </v-btn>
        </div>

        <!-- Fanart.tv is a display feature, not just a credential: the key
         - can stay in place while the images are switched off. -->
        <div v-if="service.id === 'fanart'" class="api-key-toggle">
          <v-switch
            :model-value="fanartStore.enabled"
            color="primary"
            density="compact"
            hide-details
            :label="$t('settings.fanartEnabled')"
            @update:model-value="fanartStore.setEnabled(!!$event)"
          />
          <p class="setting__hint">{{ $t('settings.fanartEnabledHint') }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useLastfmStore } from '@/stores/lastfm'
import { useFanartStore } from '@/stores/fanart'
import {
  getApiKeyStatuses,
  setApiKey,
  type ApiKeyService,
  type ApiKeyStatus,
  type ApiKeyStatuses,
} from '@/services/connect/apiKeys'
import QualityTips from './QualityTips.vue'

// Where a key is requested, per service. Opened from the button next to the
// field, so nobody has to copy the address out of a tooltip by hand.
const LASTFM_API_ACCOUNT_URL = 'https://www.last.fm/api/account/create'
const FANART_API_KEY_URL = 'https://fanart.tv/get-an-api-key/'

interface ApiKeyServiceEntry {
  id: ApiKeyService
  /** Shown in the field label, so "{service} API key" reads as the service. */
  name: string
  what: string
  steps: string[]
  getUrl: string
}

function emptyStatuses(): ApiKeyStatuses {
  return {
    lastfm: { configured: false, fromEnvironment: false },
    fanart: { configured: false, fromEnvironment: false },
  }
}

/**
 * The installation-wide keys for the external services Beacon uses. Every
 * service gets the same row - status, field, how-to, remove/save - so a new
 * one is an entry in `services` plus its i18n, not another section. The
 * backend counterpart is connect/core/api_keys.py.
 *
 * A section of its own rather than one more row under "Advanced": these are
 * services being connected, each with its own status and its own way in.
 * SettingsView decides whether to render it at all (advanced features).
 */
export default {
  name: 'ApiKeysSection',
  components: { QualityTips },
  data() {
    return {
      statuses: emptyStatuses(),
      keyInput: { lastfm: '', fanart: '' } as Record<ApiKeyService, string>,
      busy: { lastfm: false, fanart: false } as Record<ApiKeyService, boolean>,
    }
  },
  computed: {
    lastfmStore() {
      return useLastfmStore()
    },
    fanartStore() {
      return useFanartStore()
    },
    services(): ApiKeyServiceEntry[] {
      return [
        {
          id: 'lastfm',
          name: this.$t('settings.lastfmTitle'),
          what: this.$t('settings.lastfmWhat'),
          steps: [
            this.$t('settings.lastfmStep1'),
            this.$t('settings.lastfmStep2'),
            this.$t('settings.lastfmStep3'),
            this.$t('settings.lastfmStep4'),
          ],
          getUrl: LASTFM_API_ACCOUNT_URL,
        },
        {
          id: 'fanart',
          name: this.$t('settings.fanartTitle'),
          what: this.$t('settings.fanartWhat'),
          steps: [this.$t('settings.fanartStep1'), this.$t('settings.fanartStep2')],
          getUrl: FANART_API_KEY_URL,
        },
      ]
    },
  },
  created() {
    void this.loadStatuses()
  },
  methods: {
    statusFor(id: ApiKeyService): ApiKeyStatus {
      return this.statuses[id]
    },
    statusText(id: ApiKeyService): string {
      const status = this.statuses[id]
      if (!status.configured) return this.$t('settings.apiKeyMissing')
      return status.fromEnvironment
        ? this.$t('settings.apiKeyFromEnvironment')
        : this.$t('settings.apiKeyStored')
    },
    serviceName(id: ApiKeyService): string {
      return this.services.find((service) => service.id === id)?.name ?? id
    },
    async loadStatuses() {
      try {
        this.applyStatuses(await getApiKeyStatuses())
      } catch (error) {
        console.error('[settings] Failed to load API key statuses:', error)
      }
    },
    applyStatuses(statuses: ApiKeyStatuses) {
      this.statuses = statuses
      // The Last.fm builder is offered from its own store, so a key entered
      // here has to take effect without a reload.
      this.lastfmStore.configured = statuses.lastfm.configured
    },
    async saveKey(id: ApiKeyService) {
      const key = this.keyInput[id].trim()
      if (!key) return
      await this.applyKey(id, key, this.$t('settings.apiKeySaved'))
    },
    async clearKey(id: ApiKeyService) {
      await this.applyKey(id, '', this.$t('settings.apiKeyCleared'))
    },
    async applyKey(id: ApiKeyService, key: string, successMessage: string) {
      this.busy[id] = true
      const title = this.$t('settings.apiKeyLabel', { service: this.serviceName(id) })
      try {
        this.applyStatuses(await setApiKey(id, key))
        this.keyInput[id] = ''
        this.$emitter.emit('toast', { level: 'success', title, message: successMessage })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title,
          message: this.$t('settings.apiKeyFailed'),
        })
        console.error('[settings] Failed to store the API key:', error)
      } finally {
        this.busy[id] = false
      }
    },
  },
}
</script>

<style scoped>
.api-key-panel + .api-key-panel {
  margin-top: 12px;
}

.api-key-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
}

.api-key-row__field {
  flex: 1;
  min-width: 0;
}

.api-key-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.api-key-toggle {
  margin-top: 16px;
}
</style>
