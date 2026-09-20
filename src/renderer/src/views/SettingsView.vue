<template>
  <!-- Title above, controls in a panel below — the grouping every settings
   - screen worth using has, and what lets a section be scanned as one
   - block instead of as loose paragraphs sharing a margin. Each setting
   - inside a panel is the same .setting primitive (label, control, hint),
   - separated by a hairline, so vertical rhythm comes from one rule rather
   - than from per-element utility margins that drifted apart.
   -
   - The page is little more than the order of the sections: each one lives
   - in components/settings/, and the two that are conditional (Last.fm on
   - advanced features) are gated here rather than inside themselves. -->
  <v-container max-width="640" class="settings-view">
    <h1 class="page-title">{{ $t('settings.title') }}</h1>

    <account-section />

    <playback-section />

    <library-section />

    <lyrics-providers-section />

    <storage-section />

    <advanced-section />

    <!-- Shown only once advanced features are on: connecting an
     - outside service is setup work, and the switch above is what asks
     - for it (stores/advancedMode.ts). -->
    <lastfm-section v-if="advancedModeStore.enabled" />

    <about-section />
  </v-container>
</template>

<script lang="ts">
import { useAdvancedModeStore } from '@/stores/advancedMode'
import PlaybackSection from '@/components/settings/PlaybackSection.vue'
import AboutSection from '@/components/settings/AboutSection.vue'
import AdvancedSection from '@/components/settings/AdvancedSection.vue'
import AccountSection from '@/components/settings/AccountSection.vue'
import LibrarySection from '@/components/settings/LibrarySection.vue'
import StorageSection from '@/components/settings/StorageSection.vue'
import LyricsProvidersSection from '@/components/settings/LyricsProvidersSection.vue'
import LastfmSection from '@/components/settings/LastfmSection.vue'

export default {
  name: 'SettingsView',
  components: {
    PlaybackSection,
    AboutSection,
    AdvancedSection,
    AccountSection,
    LibrarySection,
    StorageSection,
    LyricsProvidersSection,
    LastfmSection,
  },
  computed: {
    advancedModeStore() {
      return useAdvancedModeStore()
    },
  },
}
</script>

<style scoped>
.page-title {
  margin-bottom: 24px;
}
</style>
