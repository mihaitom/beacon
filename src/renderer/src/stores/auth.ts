import { defineStore } from 'pinia'
import { buildSubsonicCredential } from '@/services/subsonic/client'
import { computeConnectSessionId } from '@/services/connect/session-id'
import { postConfig, getHealth } from '@/services/connect/config'
import {
  postJellyfinLogin,
  postJellyfinQuickConnectInitiate,
  postJellyfinQuickConnectStatus,
} from '@/services/connect/jellyfin'
import { clearPersistedPlayback, usePlaybackStore } from './playback'
import { clearLibraryCache } from './library'
import { capabilitiesFor, type ServerCapabilities } from '@/services/capabilities'
import type { HealthResponse } from '@/services/connect/types'

const STORAGE_KEY = 'beacon.auth'

// window.api (the Electron preload bridge) is absent in the web build — a
// plain, unencrypted localStorage stand-in there is the best a browser
// sandbox can offer anyway, and lines up with how this store already
// handled credentials before Electron's safeStorage-backed secureStorage
// existed (see readStored()'s legacy-migration branch below).
const secureStorage = window.api?.secureStorage ?? {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key)
  },
  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value)
  },
  async delete(key: string): Promise<void> {
    localStorage.removeItem(key)
  },
}

interface StoredCredentials {
  serverUrl: string
  username: string
  password: string
  credential: string
  connectUrl: string
  apiUrl: string
  connectToken: string
  serverType: 'subsonic' | 'jellyfin'
  userId: string
}

interface AuthState {
  serverUrl: string
  username: string
  password: string
  // 'subsonic' (covers Navidrome) or 'jellyfin' — picked on ServerLoginView's
  // tile grid (or filled from server_lock for a locked deployment). Drives
  // both the login flow below and services/capabilities.ts's UI gating.
  serverType: 'subsonic' | 'jellyfin'
  // Jellyfin user GUID, returned by postJellyfinLogin() — required for
  // Jellyfin's own item-lookup endpoints (see connect/media/jellyfin.py).
  // Unused/empty for Subsonic.
  userId: string
  // Base for Subsonic-proxy calls (/rest, /auth, stream.view/getCoverArt.view
  // URLs — see services/subsonic/client.ts). Electron talks to the connect
  // backend directly, so this and apiUrl below are always equal there; the
  // web/Docker build's nginx proxies the two differently (see
  // ng.conf.template), so only there do they diverge.
  connectUrl: string
  // Base for "connect-native" calls (/config, /health, /play, ... — see
  // services/connect/http.ts). Same value as connectUrl in Electron; in the
  // web build this is nginx's prefix-stripped "/api" location instead.
  apiUrl: string
  connectToken: string
  credential: string
  sessionId: string
  authenticated: boolean
  health: HealthResponse | null
  loginError: string | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    serverUrl: '',
    username: '',
    password: '',
    serverType: 'subsonic',
    userId: '',
    connectUrl: 'http://localhost:9181',
    apiUrl: 'http://localhost:9181',
    connectToken: '',
    credential: '',
    sessionId: '',
    authenticated: false,
    health: null,
    loginError: null,
  }),

  getters: {
    /** What the connected server can actually do — see
     * services/capabilities.ts. Views should check this instead of
     * comparing serverType directly. */
    capabilities(state): ServerCapabilities {
      return capabilitiesFor(state.serverType)
    },
  },

  actions: {
    /** Runs the ping → /config → /health sequence using whatever's already
     * in `this.credential` — the caller is responsible for setting it first
     * (login() builds a fresh one, restore() reuses the persisted one).
     * Does not persist anything itself. Reusing the
     * same salt/token across app restarts, instead of regenerating a fresh
     * one every time, keeps every cover-art/artist-image URL stable so the
     * browser's own HTTP cache (Navidrome sends far-future max-age) actually
     * gets used instead of invalidating on every login. */
    async _authenticate(): Promise<void> {
      this.sessionId = computeConnectSessionId({
        url: this.serverUrl,
        serverType: this.serverType,
        userId: this.userId,
        username: this.username,
      })

      // No separate client-side ping.view pre-flight here for Subsonic —
      // /config's own server-side media.ping() (see routes/devices.py)
      // already verifies the credential against exactly the URL just
      // submitted, and a 401 there now surfaces its real reason via
      // loginError (see services/connect/http.ts's extractDetail()). A
      // client-side pre-flight through routes/proxy.py's /rest/ping.view
      // used to run before any session existed, which meant it could only
      // ever reach a fixed SERVER_INTERNAL_URL — not necessarily the
      // server the user just typed in — same reasoning as why Jellyfin
      // never had one of these either.
      await postConfig({
        credential: this.credential,
        url: this.serverUrl,
        server_type: this.serverType,
        user_id: this.userId,
        username: this.username,
      })

      this.health = await getHealth()
      this.authenticated = true
    },

    /** Electron: reads CONNECT_TOKEN/connectUrl from the same connect/.env
     * the Python backend uses (dev) or from the token generated for the
     * bundled backend it just spawned (packaged build), via the main
     * process (see src/main/index.ts). Web/Docker build (no window.api):
     * reads the equivalent values injected by nginx via settings.js (see
     * settings.js.template) instead — the same trust-boundary idea as the
     * Electron path, just delivered differently: a layer the user never
     * sees knows the token, instead of the login form asking for it. */
    async loadConnectDefaults(): Promise<void> {
      if (window.api) {
        const defaults = await window.api.appConfig.getConnectDefaults()
        this.connectUrl = defaults.connectUrl
        this.apiUrl = defaults.connectUrl
        this.connectToken = defaults.connectToken
        return
      }
      this.connectUrl = window.__CONNECT_URL_BASE__ ?? ''
      this.apiUrl = window.__CONNECT_URL__ ?? '/api'
      // Deliberately not read from anywhere client-side — nginx injects
      // X-Connect-Token itself on every proxied request (see
      // ng.conf.template), so the browser never needs to know it.
      this.connectToken = ''
    },

    async login(params: {
      serverUrl: string
      username: string
      password: string
      connectUrl?: string
      serverType?: 'subsonic' | 'jellyfin'
    }): Promise<void> {
      this.loginError = null
      await this.loadConnectDefaults()
      this.serverUrl = params.serverUrl.replace(/\/+$/, '')
      this.username = params.username
      this.password = params.password
      this.serverType = params.serverType ?? 'subsonic'
      // Only meaningful in Electron — the web build's connectUrl/apiUrl are
      // always injected above and never user-editable (there's only ever
      // one possible backend: this same origin). ServerLoginView.vue's
      // "Advanced" field exists for picking a remote/local backend, which
      // only makes sense when there's no such same-origin default.
      if (window.api && params.connectUrl) {
        this.connectUrl = params.connectUrl.replace(/\/+$/, '')
        this.apiUrl = this.connectUrl
      }
      try {
        // A genuinely new login (form submission with a password) is the
        // only place the credential should be rebuilt — see
        // _authenticate()'s comment.
        if (this.serverType === 'jellyfin') {
          const { token, user_id: userId } = await postJellyfinLogin({
            url: this.serverUrl,
            username: this.username,
            password: this.password,
          })
          this.credential = token
          this.userId = userId
        } else {
          this.credential = buildSubsonicCredential(this.username, this.password)
          this.userId = ''
        }

        await this._authenticate()
        await this.persist()
      } catch (error) {
        this.authenticated = false
        this.loginError = error instanceof Error ? error.message : String(error)
        throw error
      }
    },

    /** Starts a Jellyfin Quick Connect login — sets up serverUrl/connectUrl
     * exactly like login() does, then requests a code the user approves on
     * another already-authenticated device (or Jellyfin's own web UI).
     * Returns the code to show and the secret to poll with (see
     * pollJellyfinQuickConnect()) — doesn't touch `authenticated`/persist
     * anything itself, since nothing is actually logged in yet at this
     * point. */
    async startJellyfinQuickConnect(params: {
      serverUrl: string
      connectUrl?: string
    }): Promise<{ code: string; secret: string }> {
      this.loginError = null
      await this.loadConnectDefaults()
      this.serverUrl = params.serverUrl.replace(/\/+$/, '')
      this.serverType = 'jellyfin'
      if (window.api && params.connectUrl) {
        this.connectUrl = params.connectUrl.replace(/\/+$/, '')
        this.apiUrl = this.connectUrl
      }
      const { code, secret } = await postJellyfinQuickConnectInitiate({ url: this.serverUrl })
      return { code, secret }
    },

    /** Polled every couple of seconds by ServerLoginView.vue while a Quick
     * Connect code is showing. Returns false while the user hasn't
     * approved it elsewhere yet; once approved, finishes the login the
     * same way login() does (credential/userId/username, _authenticate(),
     * persist()) and returns true. Throws only on a real error (server
     * unreachable, secret expired/rejected) — a plain "not yet approved"
     * is a normal false, not an error, so the caller's polling loop can
     * keep going without special-casing it. */
    async pollJellyfinQuickConnect(secret: string): Promise<boolean> {
      const status = await postJellyfinQuickConnectStatus({ url: this.serverUrl, secret })
      if (!status.authenticated || !status.token || !status.user_id) return false

      this.credential = status.token
      this.userId = status.user_id
      this.username = status.username ?? ''

      try {
        await this._authenticate()
        await this.persist()
      } catch (error) {
        this.authenticated = false
        this.loginError = error instanceof Error ? error.message : String(error)
        throw error
      }
      return true
    },

    /** Silent re-auth on app boot using saved credentials. Returns false
     * (without throwing) when there's nothing saved or re-auth fails, so
     * the router guard can fall back to /login without an unhandled error.
     * Reuses whatever connectUrl/connectToken were resolved at the last
     * login rather than re-querying the main process — if CONNECT_TOKEN
     * ever changes between restarts, auth fails cleanly (401 → /login),
     * which re-resolves fresh defaults; falling back to a live lookup here
     * only for old/missing data (saved before this field existed). */
    async restore(): Promise<boolean> {
      const stored = await this.readStored()
      if (!stored) return false

      this.serverUrl = stored.serverUrl
      this.username = stored.username
      this.password = stored.password
      // Falls back to 'subsonic' for data saved before this field existed.
      this.serverType = stored.serverType || 'subsonic'
      this.userId = stored.userId || ''
      if (stored.connectUrl && stored.connectToken) {
        this.connectUrl = stored.connectUrl
        // Falls back to connectUrl for data saved before this field existed.
        this.apiUrl = stored.apiUrl || stored.connectUrl
        this.connectToken = stored.connectToken
      } else {
        await this.loadConnectDefaults()
      }
      // Reuse the persisted credential as-is (see _authenticate()'s comment
      // on why — this replays the previously-issued Jellyfin AccessToken
      // through /config rather than re-doing username/password login on
      // every boot, same as Subsonic) — except for data saved before this
      // field existed, where falling back to a freshly built one is the
      // only option (Subsonic-only, since Jellyfin has no client-side way
      // to derive a token from a stored password).
      this.credential =
        stored.credential ||
        (this.serverType === 'subsonic'
          ? buildSubsonicCredential(stored.username, stored.password)
          : '')

      try {
        await this._authenticate()
        return true
      } catch (error) {
        console.error('[auth] Silent restore failed:', error)
        this.authenticated = false
        this.loginError = error instanceof Error ? error.message : String(error)
        return false
      }
    },

    async refreshHealth(): Promise<void> {
      this.health = await getHealth()
    },

    /** Reads saved credentials from the encrypted store — falling back to,
     * and migrating away from, an older plaintext localStorage entry from
     * before secure storage existed, so upgrading doesn't force a re-login. */
    async readStored(): Promise<StoredCredentials | null> {
      let encrypted: string | null
      try {
        encrypted = await secureStorage.get(STORAGE_KEY)
      } catch (error) {
        // A transient read/decrypt failure (e.g. the OS keyring not being
        // ready yet) isn't proof the data is corrupt — unlike the JSON.parse
        // failure below, this must NOT delete the stored entry, or a
        // one-off glitch would force a real re-login instead of just
        // failing this one restore attempt (the router guard tries again
        // on the next navigation, see router/index.ts).
        console.error('[auth] Failed to read stored credentials:', error)
        return null
      }
      if (encrypted) {
        try {
          return JSON.parse(encrypted)
        } catch {
          await secureStorage.delete(STORAGE_KEY)
          return null
        }
      }

      // Only reachable in Electron (in the web build, secureStorage.get()
      // above already IS this same localStorage key) — migrates a plaintext
      // entry from before safeStorage-backed secureStorage existed.
      const legacyRaw = localStorage.getItem(STORAGE_KEY)
      if (!legacyRaw) return null
      localStorage.removeItem(STORAGE_KEY)
      try {
        const legacy: StoredCredentials = JSON.parse(legacyRaw)
        await secureStorage.set(STORAGE_KEY, JSON.stringify(legacy))
        return legacy
      } catch {
        return null
      }
    },

    async persist(): Promise<void> {
      const stored: StoredCredentials = {
        serverUrl: this.serverUrl,
        username: this.username,
        password: this.password,
        credential: this.credential,
        connectUrl: this.connectUrl,
        apiUrl: this.apiUrl,
        connectToken: this.connectToken,
        serverType: this.serverType,
        userId: this.userId,
      }
      await secureStorage.set(STORAGE_KEY, JSON.stringify(stored))
    },

    async logout(): Promise<void> {
      await secureStorage.delete(STORAGE_KEY)
      clearPersistedPlayback()
      clearLibraryCache()
      usePlaybackStore().resetForLogout()
      this.authenticated = false
      this.password = ''
      this.userId = ''
      this.credential = ''
      this.sessionId = ''
      this.health = null
    },
  },
})
