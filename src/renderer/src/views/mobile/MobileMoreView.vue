<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('mobile.tabMore') }}</h1>
    </div>

    <!-- Music that is not in the library first, since it is still music;
       - then what is about this phone and this session. -->
    <v-list v-if="listenItems.length" class="mobile-more__list" bg-color="transparent">
      <v-list-item
        v-for="item in listenItems"
        :key="item.to"
        :prepend-icon="item.icon"
        :title="item.title"
        append-icon="mdi-chevron-right"
        :to="item.to"
      />
    </v-list>

    <v-list class="mobile-more__list" bg-color="transparent">
      <v-list-item
        prepend-icon="mdi-party-popper"
        :base-color="partyStore.enabled ? 'primary' : undefined"
        :title="$t('party.title')"
        @click="showPartyDialog = true"
      >
        <template v-if="partyGuests > 0" #append>
          <v-badge inline :content="partyGuests" color="primary" />
        </template>
      </v-list-item>
      <!-- Only while casting: a phone plays without a Web Audio graph,
         - so the speaker's curve is the only one there is to set. -->
      <v-list-item
        v-if="casting"
        prepend-icon="mdi-tune-vertical"
        :title="$t('equalizer.title')"
        @click="showEqualizerDialog = true"
      />
      <v-list-item
        v-if="authStore.capabilities.playHistoryStats"
        prepend-icon="mdi-chart-box-outline"
        :title="$t('nav.stats')"
        append-icon="mdi-chevron-right"
        to="/stats"
      />
      <v-list-item prepend-icon="mdi-cog-outline" :title="$t('nav.settings')" to="/settings">
        <template #append>
          <v-badge
            v-if="updateStore.unseen"
            dot
            inline
            color="primary"
            :label="$t('settings.updateBadge')"
            class="mobile-more__dot"
          />
          <v-icon icon="mdi-chevron-right" />
        </template>
      </v-list-item>
    </v-list>

    <party-mode-dialog v-model="showPartyDialog" />
    <equalizer-dialog v-if="casting" v-model="showEqualizerDialog" compact />
  </v-container>
</template>

<script lang="ts">
// The phone's fifth tab: everything that is worth reaching but is not one
// of the four tabs for getting to music. It replaced the app bar's menu
// and the Radio tab - radio and the external sources now sit together here
// as the music from outside the library, and the app bar is left to the
// current view's own actions.
import PartyModeDialog from '@/components/party/PartyModeDialog.vue'
import EqualizerDialog from '@/components/equalizer/EqualizerDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { useExternalSourceStore } from '@/stores/externalSource'
import { usePartyStore } from '@/stores/party'
import { useUpdateStore } from '@/stores/update'

export default {
  name: 'MobileMoreView',
  components: { PartyModeDialog, EqualizerDialog },
  data() {
    return {
      showPartyDialog: false,
      showEqualizerDialog: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    updateStore() {
      return useUpdateStore()
    },
    partyStore() {
      return usePartyStore()
    },
    /** Guests with the party page open right now, as PartyModeButton.vue
     * counts them. */
    partyGuests(): number {
      return this.partyStore.hostedHere ? this.partyStore.connectedGuests : 0
    },
    casting(): boolean {
      return useConnectStore().isActive
    },
    listenItems(): { to: string; icon: string; title: string }[] {
      const radio = this.authStore.capabilities.internetRadio
        ? [{ to: '/m/radio', icon: 'mdi-radio', title: this.$t('nav.radio') }]
        : []
      const sources = useExternalSourceStore().sources.map((source) => ({
        to: `/m/external/${source.id}`,
        icon: source.icon,
        title: source.name,
      }))
      return [...radio, ...sources]
    },
  },
  mounted() {
    void useExternalSourceStore().ensureLoaded()
  },
}
</script>

<style scoped>
.mobile-more__list {
  padding: 0;
}

.mobile-more__list + .mobile-more__list {
  margin-top: 8px;
  border-top: 1px solid var(--beacon-hairline);
  padding-top: 8px;
}

.mobile-more__dot {
  margin-inline-end: 8px;
}
</style>
