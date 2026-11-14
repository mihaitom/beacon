<template>
  <section v-if="visible" class="settings-section">
    <h2 class="section-title">{{ $t('settings.serverLinkTitle') }}</h2>
    <div class="beacon-panel server-link">
      <div class="server-link__head">
        <div class="link-figure" :class="`link-figure--${figureState}`" aria-hidden="true">
          <span class="link-figure__node">
            <v-icon icon="mdi-laptop" size="22" />
          </span>
          <span class="link-figure__wire">
            <span v-if="figureState === 'ok'" class="link-figure__pulse" />
            <v-icon
              v-else-if="figureState === 'warn'"
              class="link-figure__break"
              icon="mdi-link-variant-off"
              size="14"
            />
          </span>
          <span class="link-figure__node link-figure__node--server">
            <v-icon icon="mdi-server-network" size="22" />
          </span>
        </div>

        <div class="server-link__identity">
          <div class="server-link__host" :title="link?.linked ? link.url : undefined">
            {{ link?.linked ? host : $t('settings.serverLinkThisComputer') }}
          </div>
          <div class="status-row server-link__state">
            <span
              class="status-dot"
              :class="{
                'status-dot--ok': figureState === 'ok',
                'status-dot--warn': figureState === 'warn',
                'server-link__dot--off': figureState === 'off',
              }"
            />
            <span class="setting__hint setting__hint--inline">{{ stateLine }}</span>
          </div>
        </div>
      </div>

      <template v-if="link?.linked">
        <p v-if="!isHealthy" class="server-link__problem">{{ stateText }}</p>

        <dl class="server-link__facts">
          <div class="server-link__fact">
            <dt class="server-link__fact-label">{{ $t('settings.serverLinkLastSync') }}</dt>
            <dd class="server-link__fact-value">{{ lastSyncText }}</dd>
          </div>
          <div class="server-link__fact">
            <dt class="server-link__fact-label">{{ $t('settings.serverLinkUnsent') }}</dt>
            <dd
              class="server-link__fact-value"
              :class="{ 'server-link__fact-value--pending': (link.unsent ?? 0) > 0 }"
            >
              {{ link.unsent ?? 0 }}
            </dd>
          </div>
        </dl>

        <h3 class="eyebrow-label panel-title server-link__shared-title">
          {{ $t('settings.serverLinkShared') }}
        </h3>
        <div class="server-link__shared">
          <v-chip
            v-for="item in sharedItems"
            :key="item.label"
            size="small"
            variant="tonal"
            color="primary"
            :prepend-icon="item.icon"
          >
            {{ $t(item.label) }}
          </v-chip>
        </div>

        <p class="setting__hint server-link__keeps">{{ $t('settings.serverLinkUnpairKeeps') }}</p>
      </template>

      <template v-else>
        <p class="setting__description server-link__what">{{ $t('settings.serverLinkWhat') }}</p>
        <div class="server-link__fields">
          <v-text-field
            v-model="url"
            :label="$t('settings.serverLinkUrl')"
            placeholder="https://beacon.example.com"
            prepend-inner-icon="mdi-web"
            variant="solo-filled"
            spellcheck="false"
            autocomplete="off"
            hide-details
          />
          <v-text-field
            v-model="key"
            :label="$t('settings.serverLinkKey')"
            prepend-inner-icon="mdi-key-variant"
            type="password"
            variant="solo-filled"
            spellcheck="false"
            autocomplete="off"
            hide-details
            @keyup.enter="pair"
          />
        </div>
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
        <v-btn
          v-if="link?.linked"
          variant="tonal"
          prepend-icon="mdi-link-variant-off"
          :disabled="busy"
          @click="unpair"
        >
          {{ $t('settings.serverLinkUnpair') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-link-variant"
          :loading="busy"
          :disabled="!canPair"
          @click="pair"
        >
          {{ $t('settings.serverLinkPair') }}
        </v-btn>
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

// What a paired desktop shares with its server, in the order the help
// lists it (docs/help/guides/desktop-and-server.md).
const SHARED_ITEMS = [
  { icon: 'mdi-history', label: 'settings.serverLinkSharedHistory' },
  { icon: 'mdi-tune-variant', label: 'settings.serverLinkSharedSettings' },
  { icon: 'mdi-palette-outline', label: 'settings.serverLinkSharedThemes' },
  { icon: 'mdi-text-box-outline', label: 'settings.serverLinkSharedLyrics' },
  { icon: 'mdi-speaker-wireless', label: 'settings.serverLinkSharedSpeakers' },
] as const

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
      if (!at) return this.$t('settings.serverLinkNeverSynced')
      return timeAgo(at * 1000, Date.now(), this.$i18n.locale)
    },
    figureState(): 'ok' | 'warn' | 'off' {
      if (!this.link?.linked) return 'off'
      return this.isHealthy ? 'ok' : 'warn'
    },
    host(): string {
      const url = this.link?.url ?? ''
      try {
        return new URL(url).host
      } catch {
        return url
      }
    },
    stateLine(): string {
      if (!this.link?.linked) return this.$t('settings.serverLinkNotConnected')
      const as = this.$t('settings.serverLinkPairedWith', { name: this.link.remote_username })
      // A problem gets its own sentence below; here only the short form.
      const state = this.isHealthy
        ? this.$t('settings.serverLinkConnected')
        : this.$t('settings.serverLinkInterrupted')
      return `${state} · ${as}`
    },
    sharedItems() {
      return SHARED_ITEMS
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
.server-link {
  container-type: inline-size;
}

.server-link__head {
  display: flex;
  align-items: center;
  gap: 20px;
}

/* The two ends of the link and the wire between them. Drawn rather than an
 * illustration so it can carry the state: a moving pulse while connected, a
 * break while something is in the way, a dashed line before pairing. */
.link-figure {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  --link-colour: var(--v-theme-success);
}

.link-figure--warn {
  --link-colour: var(--v-theme-warning);
}

.link-figure__node {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.04);
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.link-figure--ok .link-figure__node--server {
  border-color: rgba(var(--link-colour), 0.45);
  box-shadow: 0 0 18px rgba(var(--link-colour), 0.18);
}

.link-figure--off .link-figure__node--server {
  color: rgba(var(--v-theme-on-surface), 0.35);
  border-style: dashed;
}

.link-figure__wire {
  position: relative;
  display: grid;
  place-items: center;
  width: 64px;
  height: 2px;
  background: rgba(var(--link-colour), 0.5);
  overflow: visible;
}

.link-figure--warn .link-figure__wire,
.link-figure--off .link-figure__wire {
  background: repeating-linear-gradient(
    to right,
    rgba(var(--link-colour), 0.6) 0 5px,
    transparent 5px 9px
  );
}

.link-figure--off .link-figure__wire {
  --link-colour: var(--v-theme-on-surface);
  opacity: 0.4;
}

.link-figure__break {
  padding: 2px;
  border-radius: 50%;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--link-colour));
}

/* A loop, so the slow radio-pulse speed: it shows a state, it should not
 * nag (docs/styleguide.md, Motion). */
.link-figure__pulse {
  position: absolute;
  left: 0;
  top: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(var(--link-colour));
  box-shadow: 0 0 8px rgba(var(--link-colour), 0.8);
  animation: link-pulse 2.4s ease-in-out infinite;
}

@keyframes link-pulse {
  0% {
    left: 0;
    opacity: 0;
  }
  15%,
  85% {
    opacity: 1;
  }
  100% {
    left: calc(100% - 6px);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .link-figure__pulse {
    animation: none;
    left: calc(50% - 3px);
  }
}

.server-link__identity {
  min-width: 0;
}

.server-link__host {
  font-size: 1.15rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-link__state {
  margin-top: 4px;
}

.server-link__dot--off {
  background: rgba(var(--v-theme-on-surface), 0.3);
}

.server-link__problem {
  margin-top: 14px;
  font-size: 0.875rem;
  color: rgb(var(--v-theme-warning));
}

.server-link__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.server-link__fact {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.03);
  border: 1px solid var(--beacon-hairline);
}

/* The column headings' small-label shape, muted rather than amber. */
.server-link__fact-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.server-link__fact-value {
  margin-top: 2px;
  font-size: 0.95rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.server-link__fact-value--pending {
  color: rgb(var(--v-theme-warning));
}

.server-link__shared-title {
  margin-top: 20px;
}

.server-link__shared {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.server-link__keeps {
  margin-top: 16px;
}

.server-link__what {
  margin-top: 16px;
}

.server-link__fields {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 10px;
}

.server-link__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

@container (max-width: 480px) {
  .server-link__head {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }

  .server-link__fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
