<template>
  <!-- No `temporary` — persistent/docked, not an overlay: stays open across
   - navigation and doesn't close on an outside click. -->
  <v-navigation-drawer
    :model-value="modelValue"
    location="right"
    width="380"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column fill-height">
      <v-toolbar density="compact" :title="$t('lyrics.title')" />

      <lyrics-panel v-if="currentTrack" variant="compact" class="flex-grow-1" />
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
    currentTrack() {
      return this.playbackStore.currentTrack
    },
  },
  watch: {
    // Loads on open, and again on every track change while the drawer's
    // already open — see stores/lyrics.ts's ensureLoaded() for why this
    // isn't triggered eagerly from the playback store itself instead
    // (avoids hitting three uncached third-party APIs for tracks nobody's
    // actually looking at lyrics for).
    modelValue(open: boolean) {
      if (open && this.currentTrack) useLyricsStore().ensureLoaded(this.currentTrack)
    },
    currentTrack(track) {
      if (this.modelValue && track) useLyricsStore().ensureLoaded(track)
    },
  },
}
</script>
