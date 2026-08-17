<template>
  <component :is="layout" />
  <toast-snackbar />
  <release-notes />
</template>

<script lang="ts">
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import MobileLayout from '@/layouts/MobileLayout.vue'
import ToastSnackbar from '@/components/toast.vue'
import ReleaseNotes from '@/components/releaseNotes.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { useLibraryStore } from '@/stores/library'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useIsMobileWeb } from '@/composables/useIsMobileWeb'

export default {
  name: 'App',
  components: { ToastSnackbar, ReleaseNotes },
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
          usePlaybackStore().attemptLocalResumeAfterAuth()
          // Loads the whole track catalog right away instead of waiting for
          // TracksView to mount — fetchAllTracks() is idempotent/dedupes
          // concurrent callers (see its own comment in stores/library.ts),
          // so TracksView's own created() hook calling it again later is a
          // cheap no-op once this has already resolved.
          void useLibraryStore().fetchAllTracks()
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
    usePlaybackStore().init()
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
