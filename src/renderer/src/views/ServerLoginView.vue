<template>
  <v-card min-width="440" max-width="480" class="login-card pa-6">
    <div class="login-header mb-6">
      <div class="login-icon-badge">
        <v-icon icon="mdi-lighthouse-on" size="26" color="primary" />
      </div>
      <div class="eyebrow-label mt-3">{{ $t('auth.welcomeBack') }}</div>
      <h1 class="display-title login-title">Beacon</h1>
      <div class="text-body-2 text-medium-emphasis mt-1">{{ $t('auth.chooseServer') }}</div>
    </div>

    <div v-if="checkingLock" class="d-flex justify-center my-6">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-else>
      <!-- All three server types are selectable. Skipped entirely once
       - this deployment is itself locked to one specific server (see
       - `locked` below) — there's nothing left to choose either way. -->
      <div v-if="!locked" class="server-type-grid mb-6">
        <button
          v-for="option in serverTypeOptions"
          :key="option.type"
          type="button"
          class="server-type-tile"
          :class="{
            'server-type-tile--selected': option.type === selectedServerType,
            'server-type-tile--locked': option.locked,
          }"
          :aria-pressed="option.type === selectedServerType"
          :aria-disabled="option.locked"
          :title="option.locked ? $t('auth.comingSoon') : undefined"
          @click="selectServerType(option)"
        >
          <span class="server-type-tile__icon">
            <component :is="option.icon" />
          </span>
          <span class="server-type-tile__name">{{ option.name }}</span>
          <v-icon
            v-if="option.locked"
            icon="mdi-lock-outline"
            size="12"
            class="server-type-tile__lock"
          />
        </button>
      </div>

      <v-card-text class="pa-0">
        <v-form @submit.prevent="submit">
          <v-text-field
            v-if="!locked && selectedServerType !== 'plex'"
            v-model="serverUrl"
            :label="serverUrlLabel"
            :placeholder="serverUrlPlaceholder"
            variant="solo-filled"
            class="mb-2"
          />
          <!-- Read-only, not just hidden — still worth showing which server
           - this actually is, same reasoning as SettingsView.vue's own
           - read-only server display post-login. -->
          <p v-else-if="locked" class="text-caption text-medium-emphasis mb-4">
            {{ $t('auth.serverLocked', { url: serverUrl }) }}
          </p>

          <!-- Jellyfin only — Subsonic/Navidrome and Plex have no
           - equivalent concept. Switching away cancels any in-flight Quick
           - Connect request (see setAuthMode()) so a stray poll never
           - outlives the mode it was started in. -->
          <div v-if="selectedServerType === 'jellyfin'" class="auth-mode-toggle mb-4">
            <button
              type="button"
              class="auth-mode-tab"
              :class="{ 'auth-mode-tab--active': authMode === 'password' }"
              @click="setAuthMode('password')"
            >
              {{ $t('auth.password') }}
            </button>
            <button
              type="button"
              class="auth-mode-tab"
              :class="{ 'auth-mode-tab--active': authMode === 'quickconnect' }"
              @click="setAuthMode('quickconnect')"
            >
              Quick Connect
            </button>
          </div>

          <!-- Plex authenticates a plex.tv *account*, not a per-server
           - password — no username/password fields at all, and a server
           - picker once the account's linked (see PLEX_PLAN.md). -->
          <template v-if="selectedServerType === 'plex'">
            <p v-if="!plexWaiting && !plexPickingServer" class="text-body-2 text-medium-emphasis mb-4">
              {{ $t('auth.plexHint') }}
            </p>
            <template v-else-if="plexPickingServer">
              <p class="text-body-2 text-medium-emphasis mb-3">
                {{ $t('auth.plexChooseServer') }}
              </p>
              <button
                v-for="server in plexServers"
                :key="server.machine_identifier"
                type="button"
                class="plex-server-row mb-2"
                @click="choosePlexServer(server)"
              >
                {{ server.name }}
              </button>
            </template>
            <div v-else class="quick-connect-panel mb-4">
              <p class="text-body-2 text-medium-emphasis mb-2">
                {{ $t('auth.plexWaitingHint') }}
              </p>
              <v-progress-linear indeterminate color="primary" height="4" rounded class="mt-4" />
            </div>
          </template>
          <template v-else-if="quickConnectMode">
            <p v-if="!quickConnectCode" class="text-body-2 text-medium-emphasis mb-4">
              {{ $t('auth.quickConnectHint') }}
            </p>
            <div v-else class="quick-connect-panel mb-4">
              <p class="text-body-2 text-medium-emphasis mb-2">
                {{ $t('auth.quickConnectApproveHint') }}
              </p>
              <div class="quick-connect-code">{{ quickConnectCode }}</div>
              <v-progress-linear indeterminate color="primary" height="4" rounded class="mt-4" />
            </div>
          </template>
          <template v-else>
            <v-text-field
              v-model="username"
              :label="$t('auth.username')"
              variant="solo-filled"
              class="mb-2"
            />
            <v-text-field
              v-model="password"
              :label="$t('auth.password')"
              :type="showPassword ? 'text' : 'password'"
              :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
              variant="solo-filled"
              class="mb-2"
              @click:append-inner="showPassword = !showPassword"
            />
          </template>

          <v-alert v-if="authStore.loginError" type="error" variant="tonal" class="mb-4">
            {{ authStore.loginError }}
          </v-alert>

          <v-btn v-if="showSubmitButton" type="submit" color="primary" block :loading="submitting">
            {{ submitLabel }}
          </v-btn>
          <v-btn v-else-if="plexMode" variant="text" block @click="cancelPlexLogin">
            {{ $t('common.cancel') }}
          </v-btn>
          <v-btn v-else variant="text" block @click="cancelQuickConnect">
            {{ $t('common.cancel') }}
          </v-btn>
        </v-form>
      </v-card-text>
    </template>
  </v-card>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { getHealth } from '@/services/connect/config'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'
import type { PlexServer } from '@/services/connect/types'

// How often pollJellyfinQuickConnect() is polled while a code is showing —
// frequent enough to feel responsive once approved, not so frequent it
// hammers Jellyfin for no benefit (approving it is a manual, unhurried
// step on another device).
const QUICK_CONNECT_POLL_INTERVAL_MS = 2000

export default {
  name: 'ServerLoginView',
  data() {
    return {
      serverUrl: '',
      username: '',
      password: '',
      showPassword: false,
      submitting: false,
      // Passed to authStore.login() on submit() (subsonic/jellyfin) — Plex
      // goes through its own startPlexAuth()/selectPlexServer() flow
      // instead (see the plex* fields/methods below).
      selectedServerType: 'subsonic' as 'subsonic' | 'jellyfin' | 'plex',
      // Whether checkServerLock() below has resolved yet — the server-type
      // grid/URL field stay hidden (a spinner shows instead) until we
      // actually know whether there's a choice to make at all, rather than
      // flashing the normal form for a moment and then hiding half of it.
      checkingLock: true,
      // Set once checkServerLock() gets a server_lock back from GET
      // /health — see the `locked` computed below.
      serverLock: null as { url: string; server_type: string } | null,
      // Jellyfin only — 'password' is the default/fallback for every other
      // server type, so switching selectedServerType away from 'jellyfin'
      // resets this too (see selectServerType()).
      authMode: 'password' as 'password' | 'quickconnect',
      quickConnectCode: null as string | null,
      quickConnectSecret: null as string | null,
      quickConnectTimer: null as ReturnType<typeof setTimeout> | null,
      // Plex PIN-linking flow — see startPlexLogin()/pollPlexLogin(). Three
      // states: idle (none of these set), waiting (plexWaiting, PIN issued
      // and the browser tab opened, polling for approval), picking a
      // server (plexPickingServer, approved and plexServers has >1 entry —
      // a single-server account skips straight through, see
      // pollPlexLogin()).
      plexCode: null as string | null,
      plexPinId: null as number | null,
      plexWaiting: false,
      plexPickingServer: false,
      plexServers: [] as PlexServer[],
      // Set once the PIN's approved (see pollPlexLogin()) — carried
      // through to selectPlexServer() once a server's picked.
      plexUsername: '',
      plexTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    // Computed (not a static data() array) so the labels stay correct if
    // the locale ever changes while this screen is up.
    serverTypeOptions() {
      return [
        {
          type: 'subsonic',
          name: this.$t('auth.serverTypeSubsonic'),
          icon: NavidromeIcon,
          locked: false,
        },
        {
          type: 'jellyfin',
          name: this.$t('auth.serverTypeJellyfin'),
          icon: JellyfinIcon,
          locked: false,
        },
        { type: 'plex', name: this.$t('auth.serverTypePlex'), icon: PlexIcon, locked: false },
      ]
    },
    // This deployment only ever has one possible server (see
    // connect/routes/devices.py's SERVER_LOCK) — nothing to ask the user
    // to choose, so the URL field/server-type grid don't show at all.
    locked() {
      return this.serverLock !== null
    },
    serverUrlLabel() {
      if (this.selectedServerType === 'jellyfin') return this.$t('auth.serverUrlJellyfin')
      if (this.selectedServerType === 'subsonic') return this.$t('auth.serverUrlSubsonic')
      return this.$t('auth.serverUrl')
    },
    serverUrlPlaceholder() {
      return this.selectedServerType === 'jellyfin'
        ? 'https://jellyfin.example.com'
        : 'https://navidrome.example.com'
    },
    quickConnectMode(): boolean {
      return this.selectedServerType === 'jellyfin' && this.authMode === 'quickconnect'
    },
    plexMode(): boolean {
      return this.selectedServerType === 'plex'
    },
    // The primary submit button hides once there's nothing left for it to
    // do — a Quick Connect/Plex code is already showing, or a Plex server
    // list is (the row itself is the action then) — leaving only the
    // cancel button (see the template's v-else-if chain).
    showSubmitButton(): boolean {
      if (this.plexMode) return !this.plexWaiting && !this.plexPickingServer
      return !(this.quickConnectMode && this.quickConnectCode)
    },
    submitLabel() {
      if (this.plexMode) return this.$t('auth.plexSignIn')
      if (this.quickConnectMode) return this.$t('auth.quickConnectRequestCode')
      return this.$t('auth.login')
    },
  },
  async created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
    await this.checkServerLock()
  },
  beforeUnmount() {
    this.stopQuickConnectPolling()
    this.stopPlexPolling()
  },
  methods: {
    selectServerType(option: { type: string; locked: boolean }) {
      if (option.locked) return
      this.selectedServerType = option.type as 'subsonic' | 'jellyfin' | 'plex'
      // Quick Connect only exists for Jellyfin — switching away leaves no
      // valid mode for it to keep running in.
      if (option.type !== 'jellyfin') this.setAuthMode('password')
      // Same reasoning for the Plex PIN flow — a stray poll shouldn't
      // outlive the tile it was started under.
      if (option.type !== 'plex') this.cancelPlexLogin()
    },
    setAuthMode(mode: 'password' | 'quickconnect') {
      if (this.authMode === mode) return
      this.cancelQuickConnect()
      this.authMode = mode
      this.authStore.loginError = null
    },
    async checkServerLock() {
      try {
        // Needed before GET /health can even be reached — normally
        // resolved as part of login() itself, but that's too late here
        // since this runs *before* the form (which needs to already know
        // whether to show a URL field at all) is shown.
        await this.authStore.loadConnectDefaults()
        const health = await getHealth()
        if (health.server_lock) {
          this.serverLock = health.server_lock
          this.serverUrl = health.server_lock.url
          this.selectedServerType = health.server_lock.server_type as
            | 'subsonic'
            | 'jellyfin'
            | 'plex'
        }
      } catch (error) {
        // Connect backend not reachable yet, or some other transient
        // failure — falls back to the normal unlocked form rather than
        // blocking login entirely on a check that's a nice-to-have, not a
        // requirement.
        console.error('[login] Failed to check server lock:', error)
      } finally {
        this.checkingLock = false
      }
    },
    async submit() {
      if (this.plexMode) {
        await this.startPlexLogin()
        return
      }
      if (this.quickConnectMode) {
        await this.startQuickConnect()
        return
      }
      this.submitting = true
      try {
        // login() resolves connectToken itself (see stores/auth.ts's
        // loadConnectDefaults) — the user never enters it. Plex already
        // returned above, so this is always 'subsonic'/'jellyfin' here.
        await this.authStore.login({
          serverUrl: this.serverUrl,
          username: this.username,
          password: this.password,
          serverType: this.selectedServerType as 'subsonic' | 'jellyfin',
        })
        this.goToRedirect()
      } catch {
        // authStore.loginError already holds the message, shown in the template.
      } finally {
        this.submitting = false
      }
    },
    goToRedirect() {
      const redirect = this.$route.query.redirect
      this.$router.push(typeof redirect === 'string' ? redirect : '/')
    },
    async startQuickConnect() {
      this.submitting = true
      this.authStore.loginError = null
      try {
        const { code, secret } = await this.authStore.startJellyfinQuickConnect({
          serverUrl: this.serverUrl,
        })
        this.quickConnectCode = code
        this.quickConnectSecret = secret
        this.pollQuickConnect()
      } catch (error) {
        this.authStore.loginError = error instanceof Error ? error.message : String(error)
      } finally {
        this.submitting = false
      }
    },
    async pollQuickConnect() {
      if (!this.quickConnectSecret) return
      const secret = this.quickConnectSecret
      let done: boolean
      try {
        done = await this.authStore.pollJellyfinQuickConnect(secret)
      } catch (error) {
        // authStore.loginError is already set by pollJellyfinQuickConnect —
        // just fall back to the code-request screen instead of leaving a
        // now-broken code showing with no way to retry.
        console.error('[login] Quick Connect failed:', error)
        this.quickConnectCode = null
        this.quickConnectSecret = null
        return
      }
      if (done) {
        this.goToRedirect()
        return
      }
      // Still waiting for approval on another device — the secret this
      // closure captured is checked again in case cancelQuickConnect() ran
      // while the request above was in flight, so a stale poll can't keep
      // scheduling itself after the user backed out.
      if (this.quickConnectSecret !== secret) return
      this.quickConnectTimer = setTimeout(
        () => this.pollQuickConnect(),
        QUICK_CONNECT_POLL_INTERVAL_MS,
      )
    },
    stopQuickConnectPolling() {
      if (this.quickConnectTimer) clearTimeout(this.quickConnectTimer)
      this.quickConnectTimer = null
    },
    cancelQuickConnect() {
      this.stopQuickConnectPolling()
      this.quickConnectCode = null
      this.quickConnectSecret = null
    },
    async startPlexLogin() {
      this.submitting = true
      this.authStore.loginError = null
      try {
        const { code, authUrl, pinId } = await this.authStore.startPlexAuth()
        this.plexCode = code
        this.plexPinId = pinId
        this.plexWaiting = true
        // Intercepted by main/index.ts's setWindowOpenHandler and routed
        // to shell.openExternal — opens the system browser, not a second
        // app window.
        window.open(authUrl, '_blank')
        this.pollPlexLogin()
      } catch (error) {
        this.authStore.loginError = error instanceof Error ? error.message : String(error)
      } finally {
        this.submitting = false
      }
    },
    async pollPlexLogin() {
      if (this.plexPinId === null) return
      const pinId = this.plexPinId
      let approved: { accountToken: string; username: string } | null
      try {
        approved = await this.authStore.pollPlexAuth(pinId)
      } catch (error) {
        console.error('[login] Plex PIN check failed:', error)
        this.authStore.loginError = error instanceof Error ? error.message : String(error)
        this.cancelPlexLogin()
        return
      }
      // cancelPlexLogin()/selectServerType() ran while the above awaited —
      // same guard as pollQuickConnect()'s.
      if (this.plexPinId !== pinId) return

      if (!approved) {
        this.plexTimer = setTimeout(() => this.pollPlexLogin(), QUICK_CONNECT_POLL_INTERVAL_MS)
        return
      }

      this.plexWaiting = false
      this.plexUsername = approved.username
      try {
        const servers = await this.authStore.fetchPlexServers(approved.accountToken)
        if (this.plexPinId !== pinId) return
        if (servers.length === 0) {
          this.authStore.loginError = this.$t('auth.plexNoServers')
          this.plexPinId = null
          return
        }
        const [only] = servers
        if (only && servers.length === 1) {
          await this.choosePlexServer(only)
          return
        }
        this.plexServers = servers
        this.plexPickingServer = true
      } catch (error) {
        this.authStore.loginError = error instanceof Error ? error.message : String(error)
        this.plexPinId = null
      }
    },
    async choosePlexServer(server: PlexServer) {
      this.submitting = true
      try {
        await this.authStore.selectPlexServer(server, this.plexUsername)
        this.goToRedirect()
      } catch {
        // authStore.loginError already holds the message, shown in the template.
      } finally {
        this.submitting = false
      }
    },
    stopPlexPolling() {
      if (this.plexTimer) clearTimeout(this.plexTimer)
      this.plexTimer = null
    },
    cancelPlexLogin() {
      this.stopPlexPolling()
      this.plexCode = null
      this.plexPinId = null
      this.plexWaiting = false
      this.plexPickingServer = false
      this.plexServers = []
      this.plexUsername = ''
    },
  },
}
</script>

<style scoped>
.login-card {
  background: rgba(18, 20, 28, 0.7);
  backdrop-filter: blur(20px);
}

.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.login-icon-badge {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 24px rgba(var(--v-theme-primary), 0.25);
}

/* The one deliberate animated touch on this screen — a slow breathing
 * glow behind the badge, like the actual light the app is named after
 * sweeping past. Everything else here is static. */
.login-icon-badge::before {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(245, 169, 78, 0.35), transparent 70%);
  animation: beacon-pulse 3.5s ease-in-out infinite;
}

@keyframes beacon-pulse {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-icon-badge::before {
    animation: none;
  }
}

.login-title {
  font-size: 1.75rem;
}

.server-type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.server-type-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.server-type-tile:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.server-type-tile:not(.server-type-tile--locked):hover {
  border-color: rgba(245, 169, 78, 0.35);
}

.server-type-tile__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  line-height: 1;
  filter: grayscale(1);
  opacity: 0.4;
  transition:
    filter 0.2s ease,
    opacity 0.2s ease;
}

.server-type-tile__name {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
  transition: color 0.2s ease;
}

/* Selected = lit: the exact halo + edge-light language already used for
 * the active nav-rail item and the fullscreen player's art glow, applied
 * here to "this is the signal you're tuned to" instead. */
.server-type-tile--selected {
  border-color: rgba(245, 169, 78, 0.5);
  background: rgba(245, 169, 78, 0.08);
  box-shadow: 0 0 20px rgba(245, 169, 78, 0.18);
}

.server-type-tile--selected .server-type-tile__icon {
  filter: none;
  opacity: 1;
}

.server-type-tile--selected .server-type-tile__name {
  color: #fdf6ec;
  font-weight: 600;
}

.server-type-tile--selected::after {
  content: '';
  position: absolute;
  left: 22%;
  right: 22%;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 8px 1px rgba(245, 169, 78, 0.6);
}

/* Locked = unlit: quieter, not "broken" — no red, no strikethrough, just
 * the light not having reached that shore yet. */
.server-type-tile--locked {
  cursor: default;
}

.server-type-tile__lock {
  position: absolute;
  top: 6px;
  right: 6px;
  color: rgba(255, 255, 255, 0.3);
}

.auth-mode-toggle {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.auth-mode-tab {
  flex: 1;
  padding: 8px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.auth-mode-tab:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.auth-mode-tab--active {
  background: rgba(245, 169, 78, 0.12);
  color: #fdf6ec;
  font-weight: 600;
}

.quick-connect-panel {
  text-align: center;
}

.quick-connect-code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  /* Optically balances the letter-spacing above, which otherwise reads as
   * off-center (trailing whitespace after the last digit, none before the
   * first). */
  padding-left: 0.3em;
  color: #fdf6ec;
}

.plex-server-row {
  display: block;
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  font: inherit;
  font-size: 0.9rem;
  color: #fdf6ec;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.plex-server-row:hover,
.plex-server-row:focus-visible {
  border-color: rgba(245, 169, 78, 0.4);
  background: rgba(245, 169, 78, 0.08);
}

.plex-server-row:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
