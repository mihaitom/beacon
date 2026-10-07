<template>
  <v-btn
    v-if="store.listenAvailable"
    :icon="icon"
    :color="listening ? 'primary' : undefined"
    :loading="store.listenState === 'connecting'"
    variant="text"
    density="comfortable"
    :title="label"
    :aria-label="label"
    :aria-pressed="listening"
    @click="toggle"
  />
</template>

<script lang="ts">
import { usePartyGuestStore } from '../store'

/** Listening along: the host's music in this browser. Sits in the shared
 * toolbar's actions slot next to the skip vote. */
export default {
  name: 'GuestListenButton',
  computed: {
    store() {
      return usePartyGuestStore()
    },
    listening(): boolean {
      return this.store.listenState !== 'off' && this.store.listenState !== 'failed'
    },
    icon(): string {
      if (this.store.listenState === 'failed') return 'mdi-headphones-off'
      if (this.store.listenState === 'buffering') return 'mdi-headphones-settings'
      return 'mdi-headphones'
    },
    label(): string {
      switch (this.store.listenState) {
        case 'connecting':
          return this.$t('partyGuest.listenConnecting')
        case 'failed':
          return this.$t('partyGuest.listenFailed')
        case 'off':
          return this.$t('partyGuest.listen')
        default:
          return this.$t('partyGuest.listenStop')
      }
    },
  },
  methods: {
    toggle() {
      if (this.listening) this.store.stopListening()
      else this.store.startListening()
    },
  },
}
</script>
