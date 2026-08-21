<template>
  <div>
    <!-- A plain toggle, same interaction model as PlayerBar.vue's own
     - Autoplay icon — off to on also opens the pairing code immediately (no
     - separate switch/menu to get there first), on to off just turns it
     - back off. This is now the *only* place Remote Control is turned
     - on/off at all — see SettingsView.vue, which used to duplicate this
     - before the feature moved here. -->
    <v-btn
      icon="mdi-cellphone-wireless"
      :color="remoteControlStore.enabled ? 'primary' : undefined"
      :loading="busy"
      :disabled="busy"
      variant="text"
      density="comfortable"
      :title="$t('remoteControl.title')"
      @click="onClick"
    />
    <remote-control-pairing-dialog v-model="showPairingDialog" />
  </div>
</template>

<script lang="ts">
import { useRemoteControlStore } from '@/stores/remoteControl'
import RemoteControlPairingDialog from './RemoteControlPairingDialog.vue'

export default {
  name: 'RemoteControlButton',
  components: { RemoteControlPairingDialog },
  data() {
    return {
      busy: false,
      showPairingDialog: false,
    }
  },
  computed: {
    remoteControlStore() {
      return useRemoteControlStore()
    },
  },
  methods: {
    async onClick() {
      // Captured before either action — this.remoteControlStore.enabled
      // reflects the *attempted* new state by the time a catch below would
      // read it (enable()/disable() already flip it on success, see
      // stores/remoteControl.ts), which would pick the wrong failure
      // message for whichever direction actually failed.
      const enabling = !this.remoteControlStore.enabled
      this.busy = true
      try {
        if (enabling) {
          await this.remoteControlStore.enable()
          this.showPairingDialog = true
        } else {
          await this.remoteControlStore.disable()
        }
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('remoteControl.title'),
          message: enabling
            ? this.$t('remoteControl.enableFailed')
            : this.$t('remoteControl.disableFailed'),
        })
        console.error('[player-bar] Failed to toggle remote control:', error)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
