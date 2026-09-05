<template>
  <v-card width="440" max-width="calc(100vw - 32px)" class="login-card pa-6">
    <div class="login-header mb-6">
      <div class="login-icon-badge">
        <v-icon icon="mdi-lighthouse-on" size="26" color="primary" />
      </div>
      <div class="eyebrow-label mt-3">{{ $t('auth.welcomeBack') }}</div>
      <h1 class="display-title login-title">Beacon</h1>
      <div class="text-body-medium text-medium-emphasis mt-1">{{ $t('auth.chooseServer') }}</div>
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
          <!-- Keyed by selectedServerType alone (not the finer-grained
           - sub-states within one server's own flow — auth-mode tab,
           - Quick Connect code, Plex waiting/picking-server — those still
           - swap instantly, matching the TODO's own "between the different
           - servers" scope) — switching Subsonic/Jellyfin/Plex used to pop
           - straight to a differently-shaped form (URL field vs. none,
           - username+password vs. a Plex hint, ...), snapping the whole
           - card (backdrop-blurred, so its edges are always visible even
           - while the *content* fades) to the new height instantly.
           -
           - This is *two* animations layered on top of each other, driven
           - by different elements — see login-form-wrapper below for why
           - they can't both live on the transitioning content itself:
           - 1) This content just crossfades (opacity/transform, plain CSS,
           -    <style>'s .login-form-enter-active etc.) — no height
           -    involvement at all.
           - 2) .login-form-wrapper (the actual box whose edges are
           -    visible) animates `height` directly from the old content's
           -    measured height to the new one's — see
           -    beforeFormLeave()/formEnter() in <script>. A first attempt
           -    animated *this* element's own height between 0 and its
           -    natural size instead, which technically worked but visibly
           -    collapsed the whole card down to nothing and grew it back
           -    up on every switch — correct in principle (mode="out-in"
           -    really does fully finish the old content's 0-bound shrink
           -    before the new one's 0-bound grow even starts) but not what
           -    "smoothly resize" was supposed to look like. Animating the
           -    *wrapper* directly from oldHeight to newHeight instead
           -    skips that detour through zero entirely. -->
          <div ref="formWrapper" class="login-form-wrapper">
            <transition
              name="login-form"
              mode="out-in"
              @before-leave="beforeFormLeave"
              @enter="formEnter"
              @after-enter="afterFormEnter"
            >
              <div :key="selectedServerType" class="login-form-content">
                <!-- Combobox, not a plain text field — a Subsonic/Jellyfin
                 - URL is still free text (v-combobox lets you type anything,
                 - unlike v-autocomplete which only accepts an existing item),
                 - but recentServerUrls (rememberServerUrl()/forgetServerUrl(),
                 - persisted the same "single localStorage key" way
                 - stores/playback.ts's own queue snapshot is) means you don't
                 - have to retype a server you've already signed into before.
                 - The #item slot's own delete button (@click.stop, so it
                 - doesn't also *select* the row it's deleting — the same
                 - reasoning as MobileQueueRow.vue's identical remove button)
                 - is what makes forgetting one possible. -->
                <v-combobox
                  v-if="!locked && selectedServerType !== 'plex'"
                  v-model="serverUrl"
                  :items="recentServerUrls"
                  :label="serverUrlLabel"
                  :placeholder="serverUrlPlaceholder"
                  variant="solo-filled"
                  clearable
                  class="mb-2 login-server-url"
                  name="url"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  autocomplete="url"
                  inputmode="url"
                >
                  <template #item="{ item, props: itemProps }">
                    <v-list-item v-bind="itemProps" :title="item" class="login-server-url-item">
                      <template #append>
                        <v-btn
                          icon="mdi-close"
                          size="small"
                          variant="text"
                          :title="$t('common.close')"
                          @click.stop="forgetServerUrl(item)"
                        />
                      </template>
                    </v-list-item>
                  </template>
                </v-combobox>
                <!-- Read-only, not just hidden — still worth showing which server
                 - this actually is, same reasoning as SettingsView.vue's own
                 - read-only server display post-login. -->
                <p v-else-if="locked" class="text-body-small text-medium-emphasis mb-4">
                  {{ $t('auth.serverLocked', { url: serverUrl }) }}
                </p>

                <!-- Jellyfin only — Subsonic/Navidrome and Plex have no
                 - equivalent concept. Switching away cancels any in-flight Quick
                 - Connect request (see setAuthMode()) so a stray poll never
                 - outlives the mode it was started in. -->
                <segmented-control
                  v-if="selectedServerType === 'jellyfin'"
                  :model-value="authMode"
                  :options="authModeOptions"
                  :label="$t('auth.password')"
                  class="mb-4"
                  @update:model-value="setAuthMode($event)"
                />

                <!-- Plex authenticates a plex.tv *account*, not a per-server
                 - password — no username/password fields at all, and a server
                 - picker once the account's linked, since one account can
                 - reach several servers. -->
                <template v-if="selectedServerType === 'plex'">
                  <p
                    v-if="!plexWaiting && !plexPickingServer"
                    class="text-body-medium text-medium-emphasis mb-4"
                  >
                    {{ $t('auth.plexHint') }}
                  </p>
                  <template v-else-if="plexPickingServer">
                    <p class="text-body-medium text-medium-emphasis mb-3">
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
                    <p class="text-body-medium text-medium-emphasis mb-2">
                      {{ $t('auth.plexWaitingHint') }}
                    </p>
                    <v-progress-linear
                      indeterminate
                      color="primary"
                      height="4"
                      rounded
                      class="mt-4"
                    />
                  </div>
                </template>
                <template v-else-if="quickConnectMode">
                  <p v-if="!quickConnectCode" class="text-body-medium text-medium-emphasis mb-4">
                    {{ $t('auth.quickConnectHint') }}
                  </p>
                  <div v-else class="quick-connect-panel mb-4">
                    <p class="text-body-medium text-medium-emphasis mb-2">
                      {{ $t('auth.quickConnectApproveHint') }}
                    </p>
                    <div class="quick-connect-code">{{ quickConnectCode }}</div>
                    <v-progress-linear
                      indeterminate
                      color="primary"
                      height="4"
                      rounded
                      class="mt-4"
                    />
                  </div>
                </template>
                <template v-else>
                  <v-text-field
                    v-model="username"
                    :label="$t('auth.username')"
                    variant="solo-filled"
                    clearable
                    class="mb-2"
                    name="username"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    autocomplete="username"
                  />
                  <v-text-field
                    v-model="password"
                    :label="$t('auth.password')"
                    :type="showPassword ? 'text' : 'password'"
                    :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
                    variant="solo-filled"
                    clearable
                    class="mb-2"
                    name="password"
                    autocomplete="current-password"
                    @click:append-inner="showPassword = !showPassword"
                  />
                </template>

                <v-alert v-if="authStore.loginError" type="error" variant="tonal" class="mb-4">
                  {{ authStore.loginError }}
                </v-alert>

                <v-btn
                  v-if="showSubmitButton"
                  type="submit"
                  color="primary"
                  block
                  :loading="submitting"
                >
                  {{ submitLabel }}
                </v-btn>
                <v-btn v-else-if="plexMode" variant="text" block @click="cancelPlexLogin">
                  {{ $t('common.cancel') }}
                </v-btn>
                <v-btn v-else variant="text" block @click="cancelQuickConnect">
                  {{ $t('common.cancel') }}
                </v-btn>
              </div>
            </transition>
          </div>
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
import SegmentedControl from '@/components/SegmentedControl.vue'
import type { PlexServer } from '@/services/connect/types'

// How often pollJellyfinQuickConnect() is polled while a code is showing —
// frequent enough to feel responsive once approved, not so frequent it
// hammers Jellyfin for no benefit (approving it is a manual, unhurried
// step on another device).
const QUICK_CONNECT_POLL_INTERVAL_MS = 2000

// Must match .login-form-wrapper's own `height` transition duration (0.26s)
// in <style> below — this is only used for onceHeightTransitionEnds()'s
// setTimeout fallback, which needs to wait at least that long before
// assuming transitionend is never coming (e.g. the measured height happens
// to already match, so nothing actually transitions and no event fires).
const FORM_HEIGHT_TRANSITION_MS = 260

// The server-URL combobox's own remembered-servers list — every Subsonic/
// Jellyfin URL actually signed into before (not just typed and abandoned;
// see rememberServerUrl()), most recent first. Plex has no URL field at all
// — its servers are discovered through the linked account (see
// authStore.startPlexAuth()) — so it never contributes here.
const RECENT_SERVER_URLS_KEY = 'beacon.recent-server-urls'
// Recent-*list* territory, not "keep everything forever" — a handful of
// actually-distinct servers is the realistic case (home server, a friend's,
// maybe a work one), and capping keeps forgetServerUrl() from ever needing
// to scroll through a list that just grew across every URL ever typed.
const MAX_RECENT_SERVER_URLS = 8

function loadRecentServerUrls(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVER_URLS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveRecentServerUrls(urls: string[]): void {
  try {
    localStorage.setItem(RECENT_SERVER_URLS_KEY, JSON.stringify(urls))
  } catch {
    // Storage full/unavailable — losing the remembered list is an
    // acceptable degradation, not worth surfacing to the user.
  }
}

export default {
  name: 'ServerLoginView',
  components: { SegmentedControl },
  data() {
    return {
      serverUrl: '',
      username: '',
      password: '',
      showPassword: false,
      submitting: false,
      // The server-URL combobox's own suggestions — see
      // rememberServerUrl()/forgetServerUrl() and RECENT_SERVER_URLS_KEY's
      // own comment.
      recentServerUrls: loadRecentServerUrls(),
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
    // Quick Connect is Jellyfin's own product name and stays untranslated,
    // same as it reads in the markup this replaced.
    authModeOptions() {
      return [
        { title: this.$t('auth.password'), value: 'password' },
        { title: 'Quick Connect', value: 'quickconnect' },
      ]
    },
    authStore() {
      return useAuthStore()
    },
    // Checked fresh each read rather than cached in data() at mount — a
    // decorative concern that's fine to be a plain live query, same as
    // NowPlayingView.vue's own AudioVisualizer reading it once in mounted()
    // (that one caches it since it never needs re-checking mid-session;
    // this one's just as happy re-querying, so there's no separate flag to
    // keep in sync). Used by beforeFormLeave()/formEnter() below to skip
    // the whole height-animation dance entirely for users who've asked for
    // less motion, rather than letting it play out silently and pointlessly
    // behind a `transition: none` in <style>.
    reducedMotion(): boolean {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
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
    setAuthMode(mode: string) {
      if (mode !== 'password' && mode !== 'quickconnect') return
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
            'subsonic' | 'jellyfin' | 'plex'
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
        // authStore.serverUrl, not this.serverUrl — login() strips a
        // trailing slash before storing it, and the remembered list should
        // match whatever actually gets reused/compared elsewhere instead of
        // accumulating both forms of the same URL as separate entries.
        this.rememberServerUrl(this.authStore.serverUrl)
        this.goToRedirect()
      } catch {
        // authStore.loginError already holds the message, shown in the template.
      } finally {
        this.submitting = false
      }
    },
    // replace(), not push(): the login screen must not stay behind the
    // page it hands over to, or the app bar's own back arrow (see
    // components/NavHistoryControls.vue) walks straight back into a form
    // for a session that is already signed in.
    goToRedirect() {
      const redirect = this.$route.query.redirect
      this.$router.replace(typeof redirect === 'string' ? redirect : '/')
    },
    // Called only on an actually-successful login (submit()/pollQuickConnect())
    // — not on every keystroke or a failed attempt, so the list stays "servers
    // you've really signed into", not "URLs you've ever typed or mistyped".
    rememberServerUrl(url: string) {
      if (!url) return
      const deduped = this.recentServerUrls.filter((existing) => existing !== url)
      this.recentServerUrls = [url, ...deduped].slice(0, MAX_RECENT_SERVER_URLS)
      saveRecentServerUrls(this.recentServerUrls)
    },
    // The combobox #item slot's own delete button — see the template's own
    // comment for why it's @click.stop there. Only ever removes a
    // *suggestion*; doesn't touch this.serverUrl even if it currently holds
    // the same value, same as deleting a browser's saved-address suggestion
    // doesn't clear whatever's still typed in the address bar.
    forgetServerUrl(url: string) {
      this.recentServerUrls = this.recentServerUrls.filter((existing) => existing !== url)
      saveRecentServerUrls(this.recentServerUrls)
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
        this.rememberServerUrl(this.authStore.serverUrl)
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
    // JS transition hooks for the <transition name="login-form"> around the
    // server-type-keyed form content — see that comment for the full
    // picture. These three drive .login-form-wrapper's own `height`
    // directly from the old content's measured height to the new one's; the
    // content itself (the transition's actual child) just does a plain CSS
    // opacity/transform crossfade, no height involvement on its part at all.
    //
    // Fires while the *old* content is still in the DOM, right as its leave
    // transition is about to start — pins the wrapper at that content's
    // current height as an explicit px value instead of "auto". Without
    // this, formEnter() below would have nothing to animate *from*: an
    // "auto" wrapper just recomputes instantly the moment the old content
    // is replaced by the new one, with no prior explicit value for a CSS
    // transition to interpolate away from.
    beforeFormLeave() {
      if (this.reducedMotion) return
      const wrapper = this.$refs.formWrapper as HTMLElement | undefined
      if (wrapper) wrapper.style.height = `${wrapper.scrollHeight}px`
    },
    // Fires once the *new* content has replaced the old one in the DOM
    // (still at opacity: 0 — see .login-form-enter-from) — measures its
    // real height and sets the wrapper straight to it. Pinned to a fixed
    // *old* height by beforeFormLeave() a moment ago, .login-form-wrapper's
    // own `transition: height` in <style> is what turns this single
    // assignment into a smooth resize directly from old to new, with no
    // detour through 0 the way an earlier attempt (animating the
    // *content's* own height between 0 and its natural size, instead of
    // the wrapper's between two real values) visibly collapsed the whole
    // card down and grew it back up on every switch. `done` is Vue's own
    // signal that this (now async, since the hook function takes 2
    // params) transition has finished — until it's called, mode="out-in"
    // won't consider the enter complete.
    formEnter(el: Element, done: () => void) {
      const wrapper = this.$refs.formWrapper as HTMLElement | undefined
      if (!wrapper || this.reducedMotion) {
        done()
        return
      }
      const target = el as HTMLElement
      // Forces a reflow so the height beforeFormLeave() just pinned is
      // registered before the next line changes it — without this the two
      // assignments can coalesce into one and there's nothing left to
      // animate between.
      void wrapper.offsetHeight
      wrapper.style.height = `${target.scrollHeight}px`
      this.onceHeightTransitionEnds(wrapper, done)
    },
    // Once the resize has actually finished, releases the wrapper back to
    // "auto" rather than leaving it pinned at the last measured px value —
    // content can still change height *after* this within the same server
    // type (e.g. a login error alert appearing), and a stale fixed height
    // would clip that instead of letting the card grow for it.
    afterFormEnter() {
      const wrapper = this.$refs.formWrapper as HTMLElement | undefined
      if (wrapper) wrapper.style.height = 'auto'
    },
    // transitionend firing is the normal case, but isn't guaranteed — e.g.
    // if the measured height happens to exactly match what's already
    // pinned, nothing actually transitions and the event never fires,
    // which would otherwise leave mode="out-in" waiting on a `done()` that
    // never comes (the next server-type switch silently doing nothing).
    // The timeout fallback is what makes that merely "not animated that
    // one time" instead of "the form is now stuck".
    onceHeightTransitionEnds(el: HTMLElement, callback: () => void) {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        el.removeEventListener('transitionend', onTransitionEnd)
        callback()
      }
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target === el && event.propertyName === 'height') finish()
      }
      el.addEventListener('transitionend', onTransitionEnd)
      setTimeout(finish, FORM_HEIGHT_TRANSITION_MS + 50)
    },
  },
}
</script>

<style scoped>
/* --beacon-chrome (base.css) — same solid dark tone as the rest of the
 * app's chrome, not the semi-transparent blur this used before. Opaque now,
 * so backdrop-filter: blur() has nothing left to blur — dropped along with
 * it. --beacon-hairline is the same subtle amber-tinted 1px border every
 * other card/panel in the app already uses (StatsView.vue's .stat-tile,
 * SettingsView.vue's .account-strip, ConnectDevicePicker.vue, ...) — this
 * was the one card that never actually had it. */
.login-card {
  background: var(--beacon-chrome);
  border: 1px solid var(--beacon-hairline);
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

  .login-form-enter-active,
  .login-form-leave-active,
  .login-form-wrapper {
    transition: none;
  }
}

/* The box whose edges are actually visible during a server-type switch
 * (backdrop-blurred .login-card, see the <transition>'s own template
 * comment for why this has to be a *separate* element from the content
 * that crossfades below) — animates `height` directly from the old
 * content's measured height to the new one's, driven by
 * beforeFormLeave()/formEnter() in <script>. overflow: hidden keeps
 * mid-animation content from spilling out of whatever height is currently
 * set. 0.26s must match FORM_HEIGHT_TRANSITION_MS in <script> (that
 * constant's own comment explains why). */
.login-form-wrapper {
  overflow: hidden;
  transition: height 0.26s ease;
}

/* Plain crossfade + slight rise — no height involvement here at all, see
 * .login-form-wrapper above for that. */
.login-form-enter-active,
.login-form-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.login-form-enter-from,
.login-form-leave-to {
  opacity: 0;
  transform: translateY(6px);
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
