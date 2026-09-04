<template>
  <radio-view :discover-enabled="false" :hero-header="false" />
</template>

<script lang="ts">
// Reused as-is (body only) — plain v-list with always-visible append
// buttons and standard v-dialogs, none of the hover-gating/desktop-grid
// coupling that ruled out reusing SongsView.vue/PlaylistsView.vue directly
// (see the mobile plan's reusability research). Two differences from the
// desktop rendering: discoverEnabled turns off the "Discover stations"
// entry point, a wide desktop table with no mobile-sized design of its own
// (see RadioView.vue's own comment on that table) — not a trimmed-down
// mobile version, just not offered here. heroHeader turns off the desktop
// backdrop/cover hero (sized for a wide detail page, not a phone) in favor
// of the same flat title-row every other Mobile* view already uses — see
// RadioView.vue's own v-else branch for that markup.
import RadioView from '@/views/RadioView.vue'

export default {
  name: 'MobileRadioView',
  components: { RadioView },
}
</script>
