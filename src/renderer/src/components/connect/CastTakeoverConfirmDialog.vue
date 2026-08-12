<template>
  <v-dialog :model-value="!!connectStore.pendingTakeover" max-width="420" persistent>
    <v-card v-if="connectStore.pendingTakeover">
      <v-card-title>{{ $t('connect.takeoverTitle') }}</v-card-title>
      <v-card-text>
        {{
          $t('connect.takeoverBody', {
            name: connectStore.pendingTakeover.device.name,
            owner: connectStore.pendingTakeover.owner,
          })
        }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="connectStore.cancelTakeover()">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" @click="connectStore.confirmTakeover()">{{
          $t('connect.takeOver')
        }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'

export default {
  name: 'CastTakeoverConfirmDialog',
  computed: {
    connectStore() {
      return useConnectStore()
    },
  },
}
</script>
