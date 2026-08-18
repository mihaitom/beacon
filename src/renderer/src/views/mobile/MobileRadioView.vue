<template>
  <radio-view />
</template>

<script lang="ts">
// Reused as-is — plain v-list with always-visible append buttons and
// standard v-dialogs, none of the hover-gating/desktop-grid coupling that
// ruled out reusing SongsView.vue/PlaylistsView.vue directly (see the
// mobile plan's reusability research).
import RadioView from '@/views/RadioView.vue'

export default {
  name: 'MobileRadioView',
  components: { RadioView },
}
</script>
