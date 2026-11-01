<template>
  <!-- Only where there is something to set up: a paired bridge, or one
     - connect has seen on the network. Same shape as PartyModeButton next
     - to it - the button opens the dialog, and everything happens in
     - there. -->
  <div v-if="lightsStore.available">
    <v-btn
      :icon="lightsStore.lights?.playing ? 'mdi-lightbulb-on' : 'mdi-lightbulb-outline'"
      :color="lightsStore.active ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('lights.title')"
      :aria-label="$t('lights.title')"
      @click="showDialog = true"
    />
    <lights-dialog v-model="showDialog" />
  </div>
</template>

<script lang="ts">
import { themeAccent } from '@/services/appAccent'
import { useAuthStore } from '@/stores/auth'
import { useLightsStore } from '@/stores/lights'
import LightsDialog from './LightsDialog.vue'

// A bridge can turn up after startup (its network search not done yet, the
// bridge only just plugged in), and the lights can be set up or switched
// off from another device - this app only reports its playback while they
// are on. connect itself may still be starting when the app is, which is
// the quick retry.
const RECHECK_MS = 60_000
const RETRY_MS = 5_000

export default {
  name: 'LightsButton',
  components: { LightsDialog },
  data() {
    return {
      showDialog: false,
      gone: false,
      recheck: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    lightsStore() {
      return useLightsStore()
    },
    authStore() {
      return useAuthStore()
    },
    themeAccent(): string {
      return themeAccent.value
    },
  },
  watch: {
    // The theme changed here: the lights' theme colour follows.
    themeAccent() {
      void this.lightsStore.syncTheme()
    },
    // Not before: until then the app does not know where connect is.
    'authStore.authenticated': {
      immediate: true,
      handler(authenticated: boolean) {
        clearTimeout(this.recheck)
        if (authenticated) void this.check()
      },
    },
  },
  unmounted() {
    this.gone = true
    clearTimeout(this.recheck)
  },
  methods: {
    async check() {
      await this.lightsStore.load()
      if (this.gone || !this.authStore.authenticated) return
      this.recheck = setTimeout(
        () => void this.check(),
        this.lightsStore.loadFailed ? RETRY_MS : RECHECK_MS,
      )
    },
  },
}
</script>
