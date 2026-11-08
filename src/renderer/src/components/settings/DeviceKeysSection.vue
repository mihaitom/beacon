<template>
  <section v-if="visible" class="settings-section">
    <h2 class="section-title">{{ $t('settings.deviceKeysTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.deviceKeysWhat') }}</p>

        <ul v-if="keys.length" class="device-keys__list">
          <li v-for="entry in keys" :key="entry.id" class="device-keys__row">
            <span
              class="status-dot"
              :class="entry.active ? 'status-dot--ok' : 'device-keys__dot--idle'"
            />
            <div class="device-keys__text">
              <span>{{ entry.label }}</span>
              <span class="setting__hint setting__hint--inline">{{ deviceStatus(entry) }}</span>
            </div>
            <v-spacer />
            <v-btn variant="text" :disabled="busy" @click="revoke(entry)">
              {{ $t('settings.deviceKeysRevoke') }}
            </v-btn>
          </li>
        </ul>

        <template v-if="newKey">
          <v-text-field
            :model-value="newKey"
            :label="$t('settings.deviceKeysKey')"
            readonly
            variant="solo-filled"
            density="compact"
            spellcheck="false"
            hide-details
            class="device-keys__field"
          >
            <template #append-inner>
              <v-icon
                :icon="keyCopied ? 'mdi-check' : 'mdi-content-copy'"
                :color="keyCopied ? 'success' : undefined"
                :title="$t('settings.deviceKeysCopy')"
                @click="copy"
              />
            </template>
          </v-text-field>
          <p class="setting__hint">{{ $t('settings.deviceKeysOnce') }}</p>
        </template>

        <div class="device-keys__create">
          <v-text-field
            v-model="label"
            :label="$t('settings.deviceKeysLabel')"
            :placeholder="$t('settings.deviceKeysLabelHint')"
            variant="solo-filled"
            maxlength="100"
            hide-details
            class="device-keys__label"
            @keyup.enter="create"
          />
          <v-btn color="primary" :loading="busy" :disabled="!canCreate" @click="create">
            {{ $t('settings.deviceKeysCreate') }}
          </v-btn>
        </div>

        <div class="device-keys__help">
          <v-btn
            variant="text"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'guides/desktop-and-server')"
          >
            {{ $t('settings.serverLinkDocs') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { pollingAllowed } from '@/services/connect/pollGate'
import { timeAgo } from '@/services/relativeTime'
import {
  createDeviceKey,
  listDeviceKeys,
  revokeDeviceKey,
  type DeviceKey,
} from '@/services/connect/serverLink'

// A device that was just connected should show up while someone is still
// looking at this page.
const REFRESH_MS = 10_000

/**
 * The keys that let a desktop app send this account's listening history and
 * settings to this server. The server's side of ServerLinkSection.vue.
 */
export default {
  name: 'DeviceKeysSection',
  data() {
    return {
      keys: [] as DeviceKey[],
      label: '',
      busy: false,
      /** Only right after creating: the key is never sent again. */
      newKey: '',
      keyCopied: false,
      keyCopiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
      /** Bumped by every change, so a list asked for before it is dropped. */
      listVersion: 0,
    }
  },
  computed: {
    visible(): boolean {
      return !window.api
    },
    canCreate(): boolean {
      return !this.busy && !!this.label.trim()
    },
  },
  created() {
    if (!this.visible) return
    void this.load()
    this.refreshTimer = setInterval(() => {
      if (pollingAllowed()) void this.load()
    }, REFRESH_MS)
  },
  beforeUnmount() {
    clearTimeout(this.keyCopiedTimer)
    clearInterval(this.refreshTimer)
  },
  methods: {
    async load() {
      const version = this.listVersion
      try {
        const keys = await listDeviceKeys()
        if (version === this.listVersion) this.keys = keys
      } catch (error) {
        console.error('[settings] Failed to list device keys:', error)
      }
    },
    deviceStatus(entry: DeviceKey): string {
      if (entry.active) return this.$t('settings.deviceKeysConnected')
      if (!entry.last_used_at) return this.$t('settings.deviceKeysNeverUsed')
      const ago = timeAgo(entry.last_used_at * 1000, Date.now(), this.$i18n.locale)
      return this.$t('settings.deviceKeysLastUsed', { ago })
    },
    async create() {
      if (!this.canCreate) return
      this.busy = true
      try {
        const { key, ...entry } = await createDeviceKey(this.label.trim())
        this.listVersion += 1
        this.newKey = key
        this.keys = [...this.keys, { ...entry, last_used_at: null, active: false }]
        this.label = ''
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async revoke(entry: DeviceKey) {
      this.busy = true
      try {
        await revokeDeviceKey(entry.id)
        this.listVersion += 1
        this.keys = this.keys.filter((other) => other.id !== entry.id)
        this.newKey = ''
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async copy() {
      try {
        await navigator.clipboard.writeText(this.newKey)
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
        title: this.$t('settings.deviceKeysTitle'),
        message: this.$t('settings.deviceKeysFailed'),
      })
      console.error('[settings] Device key request failed:', error)
    },
  },
}
</script>

<style scoped>
.device-keys__list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}

.device-keys__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.device-keys__dot--idle {
  background: rgba(var(--v-theme-on-surface), 0.3);
}

.device-keys__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.device-keys__field {
  margin-top: 12px;
}

.device-keys__create {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.device-keys__label {
  flex: 1;
  min-width: 0;
}

.device-keys__help {
  margin-top: 12px;
}
</style>
