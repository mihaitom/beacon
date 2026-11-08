<template>
  <section v-if="visible" class="settings-section">
    <h2 class="section-title">{{ $t('settings.deviceKeysTitle') }}</h2>
    <div class="beacon-panel beacon-panel--flush">
      <div class="device-keys__head">
        <p class="setting__description device-keys__intro">{{ $t('settings.deviceKeysWhat') }}</p>
        <v-btn variant="tonal" prepend-icon="mdi-plus" @click="adding = true">
          {{ $t('settings.deviceKeysAdd') }}
        </v-btn>
      </div>

      <ul v-if="keys.length" class="device-keys__list">
        <li v-for="entry in keys" :key="entry.id" class="device-keys__row">
          <span class="device-keys__art">
            <v-icon :icon="iconOf(entry)" size="20" />
          </span>
          <div class="device-keys__text">
            <span class="text-body-medium device-keys__name">{{ entry.label }}</span>
            <span class="device-keys__status">
              <span
                class="status-dot"
                :class="entry.active ? 'status-dot--ok' : 'device-keys__dot--idle'"
              />
              <span class="setting__hint setting__hint--inline">{{ deviceStatus(entry) }}</span>
            </span>
          </div>
          <v-btn variant="text" :disabled="busy" class="device-keys__revoke" @click="revoke(entry)">
            {{ $t('settings.deviceKeysRevoke') }}
          </v-btn>
          <div v-if="rightsOf(entry).length" class="device-keys__rights">
            <v-chip
              v-for="right in rightsOf(entry)"
              :key="right"
              size="small"
              variant="tonal"
              color="primary"
            >
              {{ right }}
            </v-chip>
          </div>
        </li>
      </ul>
    </div>
    <device-key-dialog v-model="adding" @created="onCreated" />
  </section>
</template>

<script lang="ts">
import DeviceKeyDialog from '@/components/settings/DeviceKeyDialog.vue'
import { pollingAllowed } from '@/services/connect/pollGate'
import { timeAgo } from '@/services/relativeTime'
import {
  APP_SCOPES,
  listDeviceKeys,
  revokeDeviceKey,
  type DeviceKey,
} from '@/services/connect/serverLink'

// A device that was just connected should show up while someone is still
// looking at this page.
const REFRESH_MS = 10_000

/**
 * The keys that let a desktop app send this account's listening history and
 * settings to this server, or an app of the listener's own read from it. The
 * server's side of ServerLinkSection.vue.
 */
export default {
  name: 'DeviceKeysSection',
  components: { DeviceKeyDialog },
  data() {
    return {
      keys: [] as DeviceKey[],
      adding: false,
      busy: false,
      refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
      /** Bumped by every change, so a list asked for before it is dropped. */
      listVersion: 0,
    }
  },
  computed: {
    visible(): boolean {
      return !window.api
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
    iconOf(entry: DeviceKey): string {
      return entry.scopes.includes('sync') ? 'mdi-laptop' : 'mdi-application-braces-outline'
    },
    deviceStatus(entry: DeviceKey): string {
      if (entry.active) return this.$t('settings.deviceKeysConnected')
      if (!entry.last_used_at) return this.$t('settings.deviceKeysNeverUsed')
      const ago = timeAgo(entry.last_used_at * 1000, Date.now(), this.$i18n.locale)
      return this.$t('settings.deviceKeysLastUsed', { ago })
    },
    rightsOf(entry: DeviceKey): string[] {
      if (entry.scopes.includes('sync')) {
        return entry.scopes.includes('api_keys') ? [this.$t('settings.deviceKeysSharesApi')] : []
      }
      return APP_SCOPES.filter((scope) => entry.scopes.includes(scope)).map((scope) =>
        this.$t(`settings.deviceKeysScope_${scope}`),
      )
    },
    onCreated(entry: DeviceKey) {
      this.listVersion += 1
      this.keys = [...this.keys, entry]
    },
    async revoke(entry: DeviceKey) {
      this.busy = true
      try {
        await revokeDeviceKey(entry.id)
        this.listVersion += 1
        this.keys = this.keys.filter((other) => other.id !== entry.id)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.deviceKeysTitle'),
          message: this.$t('settings.deviceKeysFailed'),
        })
        console.error('[settings] Device key request failed:', error)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped>
.device-keys__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  padding: 18px 20px;
}

.device-keys__intro.setting__description {
  flex: 1 1 280px;
  margin-bottom: 0;
}

.device-keys__list {
  container-type: inline-size;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--beacon-hairline);
}

.device-keys__row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 20px;
}

.device-keys__row + .device-keys__row {
  border-top: 1px solid var(--beacon-hairline);
}

.device-keys__art {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.device-keys__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.device-keys__name {
  overflow: hidden;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.device-keys__status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.device-keys__dot--idle {
  background: rgba(var(--v-theme-on-surface), 0.3);
}

/* Under the name and the button together, where a long chip has room. */
.device-keys__rights {
  grid-column: 2 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* A phone: the button would leave the name a few letters. */
@container (max-width: 480px) {
  .device-keys__row {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .device-keys__rights {
    grid-column: 1 / -1;
  }

  .device-keys__revoke {
    grid-column: 1 / -1;
    grid-row: 3;
    justify-self: end;
  }
}
</style>
