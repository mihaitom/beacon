<template>
  <!-- Pinned to the bar's bottom-right corner rather than to this button,
   - so it lands in the same place as PlayerToolbar.vue's volume popover
   - instead of a button-width to the side of it — see
   - .beacon-player-popover in assets/base.css, which also explains why the
   - location strategy has to be static for that to hold. -->
  <v-menu
    :close-on-content-click="false"
    location-strategy="static"
    content-class="beacon-player-popover"
  >
    <template #activator="{ props: menuProps }">
      <v-badge
        :model-value="connectStore.activeTargets.length > 0"
        :content="connectStore.activeTargets.length"
        color="primary"
      >
        <!-- density="comfortable" — every other icon button in
         - PlayerBar.vue's own toolbar sets this explicitly; without it here
         - too this rendered at Vuetify's default (larger) density, a real
         - 48px vs. 36px, not just a visual illusion — measured directly,
         - not guessed. -->
        <v-btn
          :icon="icon"
          :color="iconColor"
          variant="text"
          density="comfortable"
          v-bind="menuProps"
        />
      </v-badge>
    </template>
    <connect-device-picker />
  </v-menu>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import ConnectDevicePicker from './ConnectDevicePicker.vue'

export default {
  name: 'ConnectButton',
  components: { ConnectDevicePicker },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    icon() {
      return this.connectStore.isActive ? 'mdi-cast-connected' : 'mdi-cast'
    },
    iconColor() {
      if (this.connectStore.errors.apiUnreachable) return 'error'
      return this.connectStore.isActive ? 'primary' : undefined
    },
  },
}
</script>
