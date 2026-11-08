<template>
  <section v-if="visible" class="settings-section">
    <h2 class="section-title">{{ $t('settings.serverLinkTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.serverLinkWhat') }}</p>

        <template v-if="link?.linked">
          <div class="status-row">
            <span class="status-dot" :class="isHealthy ? 'status-dot--ok' : 'status-dot--warn'" />
            <span class="setting__hint setting__hint--inline">{{ stateText }}</span>
          </div>
          <p class="setting__hint">
            {{ $t('settings.serverLinkPairedWith', { url: link.url, name: link.remote_username }) }}
          </p>
          <p v-if="lastSyncText" class="setting__hint">{{ lastSyncText }}</p>
          <p v-if="link.unsent" class="setting__hint">
            {{ $t('settings.serverLinkUnsent', { count: link.unsent }) }}
          </p>
        </template>

        <template v-else>
          <v-text-field
            v-model="url"
            :label="$t('settings.serverLinkUrl')"
            placeholder="https://beacon.example.com"
            variant="solo-filled"
            spellcheck="false"
            autocomplete="off"
            hide-details
            class="server-link__field"
          />
          <v-text-field
            v-model="key"
            :label="$t('settings.serverLinkKey')"
            type="password"
            variant="solo-filled"
            spellcheck="false"
            autocomplete="off"
            hide-details
            class="server-link__field"
            @keyup.enter="pair"
          />
          <p class="setting__hint">{{ $t('settings.serverLinkKeyWhere') }}</p>
          <v-alert
            v-if="refusal"
            type="warning"
            variant="tonal"
            density="compact"
            class="settings-progress"
          >
            {{ refusal }}
          </v-alert>
        </template>

        <div class="server-link__actions">
          <v-btn
            variant="text"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'guides/desktop-and-server')"
          >
            {{ $t('settings.serverLinkDocs') }}
          </v-btn>
          <v-spacer />
          <v-btn v-if="link?.linked" variant="text" :disabled="busy" @click="unpair">
            {{ $t('settings.serverLinkUnpair') }}
          </v-btn>
          <v-btn v-else color="primary" :loading="busy" :disabled="!canPair" @click="pair">
            {{ $t('settings.serverLinkPair') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { syncWithAccount } from '@/services/accountScopedStores'
import { pollingAllowed } from '@/services/connect/pollGate'
import { timeAgo } from '@/services/relativeTime'
import {
  getServerLink,
  pairServerLink,
  unpairServerLink,
  type ServerLinkState,
  type ServerLinkStatus,
} from '@/services/connect/serverLink'

// Long enough not to matter, short enough that a server coming back shows
// up while someone is looking at this page.
const REFRESH_MS = 30_000

const STATE_TEXT: Record<ServerLinkState, string> = {
  connected: 'settings.serverLinkConnected',
  wrong_key: 'settings.serverLinkWrongKey',
  unreachable: 'settings.serverLinkUnreachable',
  server_too_old: 'settings.serverLinkTooOld',
  blocked: 'settings.serverLinkBlocked',
  other_account: 'settings.serverLinkOtherAccount',
  key_of_another_account: 'settings.serverLinkKeyOfAnotherAccount',
  invalid_url: 'settings.serverLinkInvalidUrl',
  insecure_url: 'settings.serverLinkInsecureUrl',
}

/**
 * Pairing this desktop app with a Beacon server, so both show the same
 * listening history and settings. Desktop only: a browser is already
 * talking to the server (DeviceKeysSection.vue is that side).
 */
export default {
  name: 'ServerLinkSection',
  data() {
    return {
      link: null as ServerLinkStatus | null,
      url: '',
      key: '',
      busy: false,
      refusal: '',
      refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
    }
  },
  computed: {
    isElectron(): boolean {
      return !!window.api
    },
    visible(): boolean {
      return this.isElectron && !!this.link?.available
    },
    isHealthy(): boolean {
      return this.link?.state === 'connected'
    },
    canPair(): boolean {
      return !this.busy && !!this.url.trim() && !!this.key.trim()
    },
    stateText(): string {
      return this.$t(STATE_TEXT[this.link?.state ?? 'connected'])
    },
    lastSyncText(): string {
      const at = this.link?.last_sync_at
      if (!at) return ''
      const ago = timeAgo(at * 1000, Date.now(), this.$i18n.locale)
      return this.$t('settings.serverLinkLastSync', { ago })
    },
  },
  created() {
    if (!this.isElectron) return
    void this.load()
    this.refreshTimer = setInterval(() => {
      if (pollingAllowed()) void this.load()
    }, REFRESH_MS)
  },
  beforeUnmount() {
    clearInterval(this.refreshTimer)
  },
  methods: {
    async load() {
      try {
        this.link = await getServerLink()
      } catch (error) {
        console.error('[settings] Failed to read the server pairing:', error)
      }
    },
    async pair() {
      if (!this.canPair) return
      this.busy = true
      this.refusal = ''
      try {
        const answer = await pairServerLink(this.url.trim(), this.key.trim())
        if (answer.error) {
          this.refusal = this.$t(STATE_TEXT[answer.error])
          return
        }
        this.link = answer
        this.url = ''
        this.key = ''
        void syncWithAccount()
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async unpair() {
      this.busy = true
      try {
        this.link = await unpairServerLink()
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    toastError(error: unknown) {
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('settings.serverLinkTitle'),
        message: this.$t('settings.serverLinkFailed'),
      })
      console.error('[settings] Server pairing request failed:', error)
    },
  },
}
</script>

<style scoped>
.server-link__field {
  margin-top: 12px;
}

.server-link__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
