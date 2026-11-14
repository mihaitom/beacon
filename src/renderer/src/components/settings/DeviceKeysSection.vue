<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.deviceKeysTitle') }}</h2>
    <div class="beacon-panel beacon-panel--flush device-keys">
      <div class="device-keys__head">
        <span class="device-keys__badge" aria-hidden="true">
          <v-icon icon="mdi-key-chain-variant" size="22" />
        </span>
        <p class="setting__description device-keys__intro">
          {{ $t(isElectron ? 'settings.deviceKeysWhatDesktop' : 'settings.deviceKeysWhat') }}
        </p>
        <v-btn
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-plus"
          class="device-keys__add"
          @click="adding = true"
        >
          {{ $t('settings.deviceKeysAdd') }}
        </v-btn>
      </div>

      <ul v-if="keys.length" class="device-keys__list">
        <li v-for="entry in keys" :key="entry.id" class="device-keys__row">
          <span class="device-keys__art" :class="{ 'device-keys__art--active': entry.active }">
            <v-icon :icon="iconOf(entry)" size="22" />
          </span>
          <div class="device-keys__text">
            <span class="device-keys__name">{{ entry.label }}</span>
            <span class="device-keys__status">
              <span
                class="status-dot"
                :class="entry.active ? 'status-dot--ok' : 'device-keys__dot--idle'"
              />
              <span class="setting__hint setting__hint--inline">{{ deviceStatus(entry) }}</span>
            </span>
          </div>
          <v-btn
            variant="tonal"
            prepend-icon="mdi-key-remove"
            :disabled="busy"
            class="device-keys__revoke"
            @click="revoke(entry)"
          >
            {{ $t('settings.deviceKeysRevoke') }}
          </v-btn>
          <div v-if="rightsOf(entry).length" class="device-keys__rights">
            <v-chip
              v-for="right in rightsOf(entry)"
              :key="right.label"
              size="small"
              variant="tonal"
              color="primary"
              :prepend-icon="right.icon"
            >
              {{ right.label }}
            </v-chip>
          </div>
        </li>
      </ul>
      <p v-else class="device-keys__empty">
        <v-icon icon="mdi-link-variant-off" size="18" />
        <span class="setting__hint setting__hint--inline">{{
          $t('settings.deviceKeysEmpty')
        }}</span>
      </p>

      <!-- An app reaches a desktop over the network, which needs a port that
         - survives a restart. Collapses when the setting has nothing to
         - show (in dev, where connect's .env decides the port). -->
      <div v-if="isElectron" class="device-keys__port">
        <connect-port-setting />
      </div>
    </div>
    <device-key-dialog v-model="adding" @created="onCreated" />
  </section>
</template>

<script lang="ts">
import ConnectPortSetting from '@/components/settings/ConnectPortSetting.vue'
import DeviceKeyDialog from '@/components/settings/DeviceKeyDialog.vue'
import { pollingAllowed } from '@/services/connect/pollGate'
import { timeAgo } from '@/services/relativeTime'
import {
  APP_SCOPES,
  listDeviceKeys,
  revokeDeviceKey,
  type AppScope,
  type DeviceKey,
} from '@/services/connect/serverLink'
import { useRemoteControlStore } from '@/stores/remoteControl'

// A device that was just connected should show up while someone is still
// looking at this page.
const REFRESH_MS = 10_000

const SCOPE_ICONS: Record<AppScope, string> = {
  history: 'mdi-history',
  stats: 'mdi-chart-box-outline',
  now_playing: 'mdi-music-note',
  lyrics: 'mdi-text-box-outline',
  control: 'mdi-play-pause',
  library: 'mdi-library-outline',
}

/**
 * The keys that let a desktop app send this account's listening history and
 * settings to this server, or an app of the listener's own read from it or
 * steer its playback. The server's side of ServerLinkSection.vue. A desktop
 * app hands out app keys only, for apps on its own network.
 */
export default {
  name: 'DeviceKeysSection',
  components: { ConnectPortSetting, DeviceKeyDialog },
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
    isElectron(): boolean {
      return !!window.api
    },
  },
  created() {
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
    rightsOf(entry: DeviceKey): { label: string; icon: string }[] {
      if (entry.scopes.includes('sync')) {
        return entry.scopes.includes('api_keys')
          ? [{ label: this.$t('settings.deviceKeysSharesApi'), icon: 'mdi-key-variant' }]
          : []
      }
      return APP_SCOPES.filter((scope) => entry.scopes.includes(scope)).map((scope) => ({
        label: this.$t(`settings.deviceKeysScope_${scope}`),
        icon: SCOPE_ICONS[scope],
      }))
    },
    onCreated(entry: DeviceKey) {
      this.listVersion += 1
      this.keys = [...this.keys, entry]
      this.followRelay()
    },
    /** On the desktop app, a key that steers playback needs the window's
     * relay running. */
    followRelay() {
      if (this.isElectron) void useRemoteControlStore().deviceKeysChanged()
    },
    async revoke(entry: DeviceKey) {
      this.busy = true
      try {
        await revokeDeviceKey(entry.id)
        this.listVersion += 1
        this.keys = this.keys.filter((other) => other.id !== entry.id)
        this.followRelay()
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
.device-keys {
  container-type: inline-size;
}

.device-keys__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 18px 20px;
}

/* The same 48px tile as the Beacon server panel's ends of the link, so the
 * two sections of the tab read as one family. */
.device-keys__badge,
.device-keys__art {
  flex: none;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.04);
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.device-keys__badge {
  color: rgb(var(--v-theme-primary));
}

.device-keys__art--active {
  border-color: rgba(var(--v-theme-success), 0.45);
  box-shadow: 0 0 18px rgba(var(--v-theme-success), 0.18);
}

.device-keys__intro.setting__description {
  flex: 1 1 260px;
  margin-bottom: 0;
}

.device-keys__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--beacon-hairline);
}

.device-keys__row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px 14px;
  padding: 14px 20px;
}

.device-keys__row + .device-keys__row {
  border-top: 1px solid var(--beacon-hairline);
}

.device-keys__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.device-keys__name {
  overflow: hidden;
  font-size: 1rem;
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

.device-keys__empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 16px 20px;
  border-top: 1px solid var(--beacon-hairline);
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.device-keys__port {
  padding: 18px 20px;
  border-top: 1px solid var(--beacon-hairline);
}

/* ConnectPortSetting renders only a comment when it has nothing to say;
 * :empty ignores comments, so the strip goes with it. */
.device-keys__port:empty {
  display: none;
}

/* A phone: the buttons would leave the name a few letters. */
@container (max-width: 480px) {
  .device-keys__add {
    width: 100%;
  }

  .device-keys__row {
    grid-template-columns: 48px minmax(0, 1fr);
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
