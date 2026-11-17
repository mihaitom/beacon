<template>
  <!-- Several roots on purpose: the buttons sit straight in their
     - parent's row (a dialog's v-card-actions, the phone page's footer), so
     - the spacer pushes the slot and Start to the far end there. -->
  <template v-if="store.enabled">
    <v-btn variant="text" color="error" :loading="busy === 'end'" @click="end">
      {{ $t('party.end') }}
    </v-btn>
    <v-btn v-if="store.hostedHere" variant="text" :loading="busy === 'rotate'" @click="rotate">
      {{ $t('party.renewLink') }}
    </v-btn>
    <v-btn v-else variant="text" @click="store.takeOver()">
      {{ $t('party.takeOver') }}
    </v-btn>
  </template>
  <v-spacer />
  <!-- The dialog's Cancel or Done; a page has nothing to close. -->
  <slot />
  <v-btn v-if="!store.enabled" color="primary" :loading="busy === 'start'" @click="start">
    {{ $t('party.start') }}
  </v-btn>
</template>

<script lang="ts">
import { usePartyStore } from '@/stores/party'

/** Starting, ending and handing on a party - see PartyModePanel.vue. */
export default {
  name: 'PartyModeActions',
  data() {
    return {
      busy: null as 'start' | 'end' | 'rotate' | null,
    }
  },
  computed: {
    store() {
      return usePartyStore()
    },
  },
  methods: {
    async run(kind: 'start' | 'end' | 'rotate', action: () => Promise<void>) {
      this.busy = kind
      try {
        await action()
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('party.title'),
          message: this.$t('party.failed'),
        })
        console.error(`[party] ${kind} failed:`, error)
      } finally {
        this.busy = null
      }
    },
    start() {
      void this.run('start', () => this.store.enable())
    },
    end() {
      void this.run('end', () => this.store.disable())
    },
    rotate() {
      void this.run('rotate', () => this.store.rotate())
    },
  },
}
</script>
