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

    <!-- Only pages here: the equalizer, a dialog about what is playing,
       - is in Now Playing's toolbar. -->
    <v-list class="mobile-more__list" bg-color="transparent">
      <v-list-item
        prepend-icon="mdi-party-popper"
        :base-color="partyStore.enabled ? 'primary' : undefined"
        :title="$t('party.title')"
        to="/m/party"
      >
        <template #append>
          <v-badge
            v-if="partyGuests > 0"
            inline
            :content="partyGuests"
            color="primary"
            class="mobile-more__badge"
          />
          <v-icon icon="mdi-chevron-right" />
        </template>
      </v-list-item>
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
            class="mobile-more__badge"
          />
          <v-icon icon="mdi-chevron-right" />
        </template>
      </v-list-item>
    </v-list>
  </v-container>
</template>

<script lang="ts">
// The phone's fifth tab: the pages worth reaching that are not one of the
// four tabs for getting to music. It replaced the app bar's menu and the
// Radio tab - radio and the external sources sit together here as the
// music from outside the library, and the app bar is left to the current
// view's own actions.
import { useAuthStore } from '@/stores/auth'
import { useExternalSourceStore } from '@/stores/externalSource'
import { usePartyStore } from '@/stores/party'
import { useUpdateStore } from '@/stores/update'

export default {
  name: 'MobileMoreView',
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

.mobile-more__badge {
  margin-inline-end: 8px;
}
</style>
