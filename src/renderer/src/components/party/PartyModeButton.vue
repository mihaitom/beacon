<template>
  <div>
    <!-- Same shape as RemoteControlButton next to it: the button only
     - opens the dialog, and starting or ending the party happens in there,
     - where it can be deliberate. The badge counts guests with the page
     - open right now. -->
    <v-badge
      :model-value="partyStore.hostedHere && partyStore.connectedGuests > 0"
      :content="partyStore.connectedGuests"
      color="primary"
    >
      <v-btn
        icon="mdi-party-popper"
        :color="partyStore.enabled ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('party.title')"
        @click="showDialog = true"
      />
    </v-badge>
    <party-mode-dialog v-model="showDialog" />
  </div>
</template>

<script lang="ts">
import { usePartyStore } from '@/stores/party'
import PartyModeDialog from './PartyModeDialog.vue'

export default {
  name: 'PartyModeButton',
  components: { PartyModeDialog },
  data() {
    return {
      showDialog: false,
    }
  },
  computed: {
    partyStore() {
      return usePartyStore()
    },
  },
}
</script>
