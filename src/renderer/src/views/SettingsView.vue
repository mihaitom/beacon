<template>
  <!-- Title above, then one tab per group of settings. Each group lives in
   - components/settings/ and the page is little more than the order of
   - them; Casting (web/Docker admin) and Advanced (any admin) are the only
   - conditional tabs.
   -
   - Where the page has room the tab bar turns into a column of its own on
   - the left, so the settings get the width a desktop window has instead
   - of a phone-sized strip in the middle of it. Decided on the page's own
   - width rather than the viewport's: the desktop shell never switches to
   - the phone layout, and its sidebar and queue take their share first. -->
  <v-container ref="root" fluid class="settings-view">
    <div class="settings-layout" :class="{ 'settings-layout--wide': wide }">
      <h1 class="page-title settings-layout__title">{{ $t('settings.title') }}</h1>

      <v-tabs
        v-model="tab"
        color="primary"
        :direction="wide ? 'vertical' : 'horizontal'"
        :show-arrows="!wide"
        class="settings-tabs"
      >
        <v-tab
          v-for="entry in tabs"
          :key="entry.value"
          :value="entry.value"
          :prepend-icon="wide ? entry.icon : undefined"
        >
          {{ $t(entry.label) }}
        </v-tab>
      </v-tabs>

      <!-- Every panel stays mounted (`eager`), the way the page used to mount
         - all sections at once: each one loads its own state in created()
         - (the log level, the running scan, the casting policy), and
         - unmounting it on a tab switch would make every visit re-fetch that
         - and lose a half-filled form. Hidden panels are display:none, so
         - nothing shows twice. -->
      <v-tabs-window v-model="tab" class="settings-layout__content">
        <v-tabs-window-item value="account" eager>
          <account-section />
          <server-link-section />
          <device-keys-section />
          <about-section />
        </v-tabs-window-item>

        <v-tabs-window-item value="appearance" eager>
          <appearance-section />
        </v-tabs-window-item>

        <v-tabs-window-item value="playback" eager>
          <playback-section />
          <lyrics-providers-section />
        </v-tabs-window-item>

        <v-tabs-window-item value="library" eager>
          <library-section />
          <external-source-section />
        </v-tabs-window-item>

        <v-tabs-window-item v-if="castingVisible" value="casting" eager>
          <cast-permissions-section />
        </v-tabs-window-item>

        <v-tabs-window-item v-if="advancedVisible" value="advanced" eager>
          <advanced-section />
          <storage-section />
          <api-keys-section />
          <home-automation-section />
        </v-tabs-window-item>
      </v-tabs-window>
    </div>
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import PlaybackSection from '@/components/settings/PlaybackSection.vue'
import AboutSection from '@/components/settings/AboutSection.vue'
import AdvancedSection from '@/components/settings/AdvancedSection.vue'
import AccountSection from '@/components/settings/AccountSection.vue'
import AppearanceSection from '@/components/settings/AppearanceSection.vue'
import LibrarySection from '@/components/settings/LibrarySection.vue'
import CastPermissionsSection from '@/components/settings/CastPermissionsSection.vue'
import ExternalSourceSection from '@/components/settings/ExternalSourceSection.vue'
import StorageSection from '@/components/settings/StorageSection.vue'
import LyricsProvidersSection from '@/components/settings/LyricsProvidersSection.vue'
import ApiKeysSection from '@/components/settings/ApiKeysSection.vue'
import HomeAutomationSection from '@/components/settings/HomeAutomationSection.vue'
import ServerLinkSection from '@/components/settings/ServerLinkSection.vue'
import DeviceKeysSection from '@/components/settings/DeviceKeysSection.vue'

/** Room for the tab column, the gap and a settings column that is no
 * narrower than the single column of the narrow layout (200 + 40 + 640). */
const WIDE_LAYOUT_MIN_WIDTH = 880

interface SettingsTab {
  value: string
  label: string
  icon: string
}

export default {
  name: 'SettingsView',
  components: {
    PlaybackSection,
    AboutSection,
    AdvancedSection,
    AccountSection,
    AppearanceSection,
    LibrarySection,
    CastPermissionsSection,
    ExternalSourceSection,
    StorageSection,
    LyricsProvidersSection,
    ApiKeysSection,
    HomeAutomationSection,
    ServerLinkSection,
    DeviceKeysSection,
  },
  data() {
    return {
      tab: 'account',
      wide: false,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    tabs(): SettingsTab[] {
      return [
        { value: 'account', label: 'settings.account', icon: 'mdi-account-circle-outline' },
        { value: 'appearance', label: 'settings.appearanceTitle', icon: 'mdi-palette-outline' },
        { value: 'playback', label: 'settings.playbackTitle', icon: 'mdi-play-circle-outline' },
        { value: 'library', label: 'settings.libraryTitle', icon: 'mdi-bookshelf' },
        ...(this.castingVisible
          ? [{ value: 'casting', label: 'settings.castPermissionsTitle', icon: 'mdi-cast' }]
          : []),
        ...(this.advancedVisible
          ? [{ value: 'advanced', label: 'settings.advancedTitle', icon: 'mdi-tune-variant' }]
          : []),
      ]
    },
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
     * the AirPlay pairings, the API keys, home automation access and the
     * cache clearing. On the
     * web/Docker build that makes it a server administrator's, but the
     * desktop app runs its own single-user backend, where there is nobody
     * else to keep it from, so it shows it whatever the media account's own
     * admin flag says. */
    advancedVisible(): boolean {
      return !!window.api || this.authStore.isAdmin === true
    },
  },
  mounted() {
    const root = (this.$refs.root as { $el: HTMLElement }).$el
    this.resizeObserver = new ResizeObserver(([entry]) => {
      this.wide = entry!.contentRect.width >= WIDE_LAYOUT_MIN_WIDTH
    })
    this.resizeObserver.observe(root)
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
}
</script>

<style scoped>
.settings-layout {
  max-width: 640px;
  margin-inline: auto;
}

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

/* The tab bar as a column beside the settings. It stays in view while a
 * long tab (Account, Advanced) scrolls, so switching never means scrolling
 * back up first. */
.settings-layout--wide {
  display: grid;
  grid-template-columns: 200px minmax(0, 720px);
  grid-template-areas:
    'title title'
    'nav content';
  column-gap: 40px;
  max-width: 960px;
}

.settings-layout--wide .settings-layout__title {
  grid-area: title;
}

.settings-layout--wide .settings-tabs {
  grid-area: nav;
  align-self: start;
  position: sticky;
  top: 16px;
  margin-bottom: 0;
}

.settings-layout--wide .settings-layout__content {
  grid-area: content;
}

.settings-layout--wide .settings-tabs :deep(.v-tab) {
  border-radius: 8px;
  padding-inline: 14px;
}

.settings-layout--wide .settings-tabs :deep(.v-tab .v-btn__prepend) {
  margin-inline-end: 12px;
}
</style>
