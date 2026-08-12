<template>
  <component :is="layout" />
  <toast-snackbar />
  <release-notes />
</template>

<script lang="ts">
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import ToastSnackbar from '@/components/toast.vue'
import ReleaseNotes from '@/components/releaseNotes.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'

export default {
  name: 'App',
  components: { ToastSnackbar, ReleaseNotes },
  computed: {
    layout() {
      return this.$route.meta.layout === 'auth' ? AuthLayout : DefaultLayout
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
  },
}
</script>
