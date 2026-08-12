<template>
  <v-menu :close-on-content-click="false" location="top">
    <template #activator="{ props: menuProps }">
      <v-badge
        :model-value="connectStore.activeTargets.length > 0"
        :content="connectStore.activeTargets.length"
        color="primary"
      >
        <v-btn :icon="icon" :color="iconColor" variant="text" v-bind="menuProps" />
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
