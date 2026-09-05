<template>
  <component :is="layout" />
  <toast-snackbar />
  <release-notes />
  <update-toast />
  <keyboard-shortcuts-dialog />
  <artwork-lightbox />
  <song-info-dialog />
</template>

<script lang="ts">
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import MobileLayout from '@/layouts/MobileLayout.vue'
import ToastSnackbar from '@/components/toast.vue'
import ReleaseNotes from '@/components/releaseNotes.vue'
import UpdateToast from '@/components/UpdateToast.vue'
import KeyboardShortcutsDialog from '@/components/KeyboardShortcutsDialog.vue'
import ArtworkLightbox from '@/components/library/ArtworkLightbox.vue'
import SongInfoDialog from '@/components/library/SongInfoDialog.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { useLibraryStore } from '@/stores/library'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useUpdateStore } from '@/stores/update'
import { useIsMobileWeb } from '@/composables/useIsMobileWeb'
import { initKeyboardShortcuts } from '@/services/keyboardShortcuts'
import { initNavigationHistory } from '@/services/navigationHistory'
import { initAccountScopedStores } from '@/services/accountScopedStores'

export default {
  name: 'App',
  components: {
    ToastSnackbar,
    ReleaseNotes,
    UpdateToast,
    KeyboardShortcutsDialog,
    ArtworkLightbox,
    SongInfoDialog,
  },
  // Composition API escape hatch just for useIsMobileWeb() — everything else
  // here stays Options API, matching the rest of the renderer. Refs returned
  // from setup() auto-unwrap when read via `this` below (isMobileWeb, not
  // isMobileWeb.value).
  setup() {
    return { isMobileWeb: useIsMobileWeb() }
  },
  computed: {
    layout() {
      if (this.$route.meta.layout === 'auth') return AuthLayout
      // Electron never shows this, regardless of window size — isMobileWeb
      // is already false there unconditionally (see useIsMobileWeb.ts).
      if (this.isMobileWeb) return MobileLayout
      return DefaultLayout
    },
    authStore() {
      return useAuthStore()
    },
  },
  watch: {
    'authStore.authenticated': {
      // No `immediate: true` — main.ts mounts the app without waiting for
      // router.isReady(), so an immediate fire would run with the initial
      // `authenticated: false` before the router guard's own restore()
      // attempt (see router/index.ts) has had a chance to run, force-
      // navigating to /login and racing ahead of a successful silent
      // restore. The guard already handles the cold-start case correctly;
      // this watcher only needs to react to later transitions (login/
      // logout/session-loss), which a non-immediate watch still catches.
      handler(authenticated: boolean) {
        const connectStore = useConnectStore()
        if (authenticated) {
          connectStore.subscribeEvents()
          connectStore.refreshDevices()
          // Local-playback auto-resume itself lives in authStore.restore()
          // now, not here — this handler also fires after a genuine fresh
          // login (typing credentials, Quick Connect, Plex), where blasting
          // out whatever was persisted from a previous session/account made
          // no sense (see restore()'s own comment on attemptLocalResumeAfterAuth()).
          // Loads the whole song catalog right away instead of waiting for
          // SongsView to mount — fetchAllSongs() is idempotent/dedupes
          // concurrent callers (see its own comment in stores/library.ts),
          // so SongsView's own created() hook calling it again later is a
          // cheap no-op once this has already resolved.
          void useLibraryStore().fetchAllSongs()
        } else {
          connectStore.unsubscribeEvents()
          if (this.$route.name !== 'login') {
            this.$router.push({ name: 'login', query: { redirect: this.$route.fullPath } })
          }
        }
      },
    },
  },
  created() {
    // Before anything else touches an account-scoped store below — sets up
    // the watcher that fixes their state up once the real account is known
    // (see that module's own comment for why this can't just be a
    // one-time read at store-creation time).
    initAccountScopedStores()
    usePlaybackStore().init()
    // Window-level, so a shortcut works wherever focus happens to be
    // (see resolveShortcut() for what it deliberately keeps its hands off).
    initKeyboardShortcuts()
    // Tracks whether there is anywhere to go back/forward to, and picks up
    // the mouse's own back/forward buttons — see that module for why the
    // router's history is the only bookkeeping this needs.
    initNavigationHistory()
    // Not gated on media-server auth — same reasoning as the Remote Control
    // status refresh below, just checking GitHub instead of connect. Not
    // awaited: UpdateToast.vue/SettingsView.vue both read the store
    // reactively and just show nothing until this resolves.
    void useUpdateStore().check()
    // loadConnectDefaults() resolves connectUrl/apiUrl/connectToken for this
    // build/deployment — normally a side effect of the router guard's own
    // restore()/login() calls, which this doesn't wait on. Without awaiting
    // it here first, refreshStatus() below used to fire immediately against
    // the auth store's raw default state (stores/auth.ts's
    // `apiUrl: 'http://localhost:9181'`, a local-Electron-dev value) instead
    // — harmless in Electron (that default happens to already be correct
    // there) but a real wrong-origin 401 in the web build, where it should
    // instead resolve to '/api'.
    // Remote Control (LAN PIN-pairing a phone against *this* desktop window)
    // is Electron-only — see SettingsView.vue's identical `isElectron` gate.
    // A Docker/web deployment has no separate desktop instance to pair
    // against, and the mobile web view covers that use case directly.
    if (window.api) {
      void useAuthStore()
        .loadConnectDefaults()
        .then(() => {
          // Not gated on media-server auth — Remote Control lives at the
          // connect level (same as casting's own connectToken/apiUrl),
          // independent of which account happens to be logged into this
          // window. See refreshStatus()'s own comment for why this call is
          // needed at all (reconciling a renderer reload against connect's
          // still-running state).
          void useRemoteControlStore().refreshStatus()
        })
    }
    // window.api is absent in the web build (no Electron main process to
    // ask this of) — casting there just keeps running until the backend's
    // own session-idle reaper eventually cleans it up, same as it always
    // has. See main/index.ts's requestQuit() for why this has to be the
    // renderer's job rather than something main can do on its own.
    window.api?.appLifecycle.onBeforeQuit(async () => {
      try {
        const connect = useConnectStore()
        if (connect.isActive) await connect.stopAll()
        const remoteControl = useRemoteControlStore()
        if (remoteControl.enabled) await remoteControl.disable()
      } catch (error) {
        console.error('[app] Failed to stop casting/remote control before quit:', error)
      } finally {
        window.api?.appLifecycle.beforeQuitDone()
      }
    })
  },
}
</script>
