<template>
  <!-- `temporary` so this floats over the main content instead of pushing/
   - resizing it (Vuetify's default non-temporary drawer reserves layout
   - space, which reflowed every view underneath every time this opened/
   - closed) — `persistent` keeps it open across navigation and on an
   - outside click regardless, and `scrim="false"` drops the darkening
   - backdrop `temporary` would otherwise add, since the point is to keep
   - browsing the rest of the app comfortably while this stays open. -->
  <v-navigation-drawer
    :model-value="modelValue"
    location="right"
    width="380"
    temporary
    persistent
    :scrim="false"
    color="#0B0D13"
    class="beacon-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column fill-height">
      <v-toolbar
        density="compact"
        color="#0B0D13"
        class="beacon-drawer__toolbar"
        :title="$t('lyrics.title')"
      />

      <lyrics-panel v-if="currentSong" variant="compact" class="flex-grow-1" />
      <v-list-item v-else>
        <span class="text-medium-emphasis text-body-2">{{ $t('nowPlaying.nothingPlaying') }}</span>
      </v-list-item>
    </div>
  </v-navigation-drawer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import LyricsPanel from './LyricsPanel.vue'

export default {
  name: 'LyricsDrawer',
  components: { LyricsPanel },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
  },
  watch: {
    // Loads on open, and again on every song change while the drawer's
    // already open — see stores/lyrics.ts's ensureLoaded() for why this
    // isn't triggered eagerly from the playback store itself instead
    // (avoids hitting three uncached third-party APIs for songs nobody's
    // actually looking at lyrics for).
    modelValue(open: boolean) {
      if (open && this.currentSong) useLyricsStore().ensureLoaded(this.currentSong)
    },
    currentSong(song) {
      if (this.modelValue && song) useLyricsStore().ensureLoaded(song)
    },
  },
}
</script>

<style scoped>
/* Matches the app's own dark chrome (PlayerBar.vue/DefaultLayout.vue's
 * app-bar/rail) rather than Vuetify's default surface color — now that this
 * floats over content as its own panel (see `temporary` in the template),
 * it reads more like a bolted-on default dialog without this. */
.beacon-drawer {
  border-left: 1px solid var(--beacon-hairline);
}

.beacon-drawer__toolbar {
  border-bottom: 1px solid var(--beacon-hairline);
}
</style>
