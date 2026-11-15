<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('party.title') }}</h1>
      <v-btn
        icon="mdi-help-circle-outline"
        variant="text"
        :title="$t('help.title')"
        @click="$emitter.emit('openHelp', 'guides/party-mode')"
      />
    </div>

    <party-mode-panel />

    <div class="mobile-party__actions">
      <party-mode-actions />
    </div>
  </v-container>
</template>

<script lang="ts">
// The party on the phone: the desktop dialog's panel as a page, reached
// from the More tab. In a dialog it was squeezed - the invitation, the
// rules and the guests one under the other in a box that scrolled.
import PartyModePanel from '@/components/party/PartyModePanel.vue'
import PartyModeActions from '@/components/party/PartyModeActions.vue'

export default {
  name: 'MobilePartyView',
  components: { PartyModePanel, PartyModeActions },
}
</script>

<style scoped>
.mobile-party__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 24px;
}
</style>
