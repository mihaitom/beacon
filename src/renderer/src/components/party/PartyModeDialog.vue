<template>
  <v-dialog :model-value="modelValue" max-width="900" scrollable @update:model-value="onClose">
    <v-card class="beacon-dialog">
      <v-card-title class="party-title">
        <span>{{ $t('party.title') }}</span>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('help.title')"
          @click="$emitter.emit('openHelp', 'guides/party-mode')"
        />
      </v-card-title>
      <v-card-text>
        <party-mode-panel ref="panel" />
      </v-card-text>

      <v-card-actions>
        <party-mode-actions>
          <v-btn v-if="store.enabled" color="primary" @click="onClose(false)">
            {{ $t('common.done') }}
          </v-btn>
          <v-btn v-else variant="text" @click="onClose(false)">{{ $t('common.cancel') }}</v-btn>
        </party-mode-actions>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
// The desktop's party settings. The phone shows the same panel as a page
// of its own (views/mobile/MobilePartyView.vue), where a dialog left it
// squeezed.
import { usePartyStore } from '@/stores/party'
import PartyModePanel from './PartyModePanel.vue'
import PartyModeActions from './PartyModeActions.vue'

export default {
  name: 'PartyModeDialog',
  components: { PartyModePanel, PartyModeActions },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  computed: {
    store() {
      return usePartyStore()
    },
  },
  watch: {
    // The panel refreshes itself when it first mounts; on every later
    // opening it is still mounted from the last one.
    modelValue(open: boolean) {
      if (!open) return
      ;(this.$refs.panel as InstanceType<typeof PartyModePanel> | undefined)?.refresh()
    },
  },
  methods: {
    onClose(value: boolean) {
      this.$emit('update:modelValue', value)
    },
  },
}
</script>

<style scoped>
.party-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
