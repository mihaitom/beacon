<template>
  <radio-view :discover-enabled="false" />
</template>

<script lang="ts">
// Reused as-is — plain v-list with always-visible append buttons and
// standard v-dialogs, none of the hover-gating/desktop-grid coupling that
// ruled out reusing SongsView.vue/PlaylistsView.vue directly (see the
// mobile plan's reusability research). The one difference: discoverEnabled
// turns off the "Discover stations" entry point, a wide desktop table with
// no mobile-sized design of its own (see RadioView.vue's own comment on
// that table) — not a trimmed-down mobile version, just not offered here.
import RadioView from '@/views/RadioView.vue'

export default {
  name: 'MobileRadioView',
  components: { RadioView },
}
</script>
