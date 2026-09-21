<template>
  <!-- Title above, then one tab per group of settings. Each group lives in
   - components/settings/ and the page is little more than the order of
   - them; Casting (web/Docker admin) and Advanced (any admin) are the only
   - conditional tabs. -->
  <v-container max-width="640" class="settings-view">
    <h1 class="page-title">{{ $t('settings.title') }}</h1>

    <v-tabs v-model="tab" color="primary" show-arrows class="settings-tabs">
      <v-tab value="account">{{ $t('settings.account') }}</v-tab>
      <v-tab value="playback">{{ $t('settings.playbackTitle') }}</v-tab>
      <v-tab value="library">{{ $t('settings.libraryTitle') }}</v-tab>
      <v-tab v-if="castingVisible" value="casting">
        {{ $t('settings.castPermissionsTitle') }}
      </v-tab>
      <v-tab v-if="advancedVisible" value="advanced">
        {{ $t('settings.advancedTitle') }}
      </v-tab>
    </v-tabs>

    <!-- Every panel stays mounted (`eager`), the way the page used to mount
       - all sections at once: each one loads its own state in created()
       - (the log level, the running scan, the casting policy), and
       - unmounting it on a tab switch would make every visit re-fetch that
       - and lose a half-filled form. Hidden panels are display:none, so
       - nothing shows twice. -->
    <v-tabs-window v-model="tab">
      <v-tabs-window-item value="account" eager>
        <account-section />
        <about-section />
      </v-tabs-window-item>

      <v-tabs-window-item value="playback" eager>
        <playback-section />
        <lyrics-providers-section />
      </v-tabs-window-item>

      <v-tabs-window-item value="library" eager>
        <library-section />
      </v-tabs-window-item>

      <v-tabs-window-item v-if="castingVisible" value="casting" eager>
        <cast-permissions-section />
      </v-tabs-window-item>

      <v-tabs-window-item v-if="advancedVisible" value="advanced" eager>
        <advanced-section />
        <storage-section />
        <api-keys-section />
      </v-tabs-window-item>
    </v-tabs-window>
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import PlaybackSection from '@/components/settings/PlaybackSection.vue'
import AboutSection from '@/components/settings/AboutSection.vue'
import AdvancedSection from '@/components/settings/AdvancedSection.vue'
import AccountSection from '@/components/settings/AccountSection.vue'
import LibrarySection from '@/components/settings/LibrarySection.vue'
import CastPermissionsSection from '@/components/settings/CastPermissionsSection.vue'
import StorageSection from '@/components/settings/StorageSection.vue'
import LyricsProvidersSection from '@/components/settings/LyricsProvidersSection.vue'
import ApiKeysSection from '@/components/settings/ApiKeysSection.vue'

export default {
  name: 'SettingsView',
  components: {
    PlaybackSection,
    AboutSection,
    AdvancedSection,
    AccountSection,
    LibrarySection,
    CastPermissionsSection,
    StorageSection,
    LyricsProvidersSection,
    ApiKeysSection,
  },
  data() {
    return {
      tab: 'account',
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    /** Same condition as CastPermissionsSection's own `visible` — the tab
     * must not exist for a session the section would render nothing for.
     * Kept in step by hand; the component guards itself either way. */
    castingVisible(): boolean {
      return !window.api && this.authStore.capabilities.castPermissions
    },
    /** The Advanced tab is the installation-wide settings — the log level,
     * the AirPlay pairings, the API keys and the cache clearing. On the
     * web/Docker build that makes it a server administrator's, but the
     * desktop app runs its own single-user backend, where there is nobody
     * else to keep it from, so it shows it whatever the media account's own
     * admin flag says. */
    advancedVisible(): boolean {
      return !!window.api || this.authStore.isAdmin === true
    },
  },
}
</script>

<style scoped>
.page-title {
  margin-bottom: 16px;
}

.settings-tabs {
  margin-bottom: 20px;
}

/* Vuetify's tab labels default to a wide-tracked, capitalised treatment
 * that reads as stock Material next to the app's own headings; this is the
 * same label at the app's body weight, so the bar belongs to the page
 * rather than sitting on it. The active indicator stays Vuetify's
 * `primary`, which is the app's amber. */
.settings-tabs :deep(.v-tab) {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
  font-size: 0.95rem;
}
</style>
