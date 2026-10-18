<template>
  <!-- Everything that operates on a queue is disabled while a radio
   - station is playing: there is no queue behind it (see the playback
   - store's own early returns in playNext()/playPrevious()/
   - toggleShuffle()), so these buttons could only ever look pressable and
   - then do nothing. Play/pause is the one transport control a live
   - stream genuinely has. -->
  <div class="center-controls">
    <v-btn
      icon="mdi-shuffle"
      :color="!isRadio && playbackStore.shuffle ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :disabled="isRadio"
      :title="titles.shuffle"
      :aria-label="titles.shuffle"
      @click="playbackStore.toggleShuffle()"
    />
    <v-btn
      icon="mdi-skip-previous"
      variant="text"
      density="comfortable"
      :disabled="isRadio || !hasPlayable"
      :title="titles.previous"
      :aria-label="titles.previous"
      @click="playbackStore.playPrevious()"
    />
    <v-btn
      class="play-btn"
      :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
      variant="flat"
      color="primary"
      size="large"
      density="comfortable"
      :disabled="!hasPlayable"
      :title="titles.play"
      :aria-label="titles.play"
      @click="playbackStore.togglePlay()"
    />
    <v-btn
      icon="mdi-skip-next"
      variant="text"
      density="comfortable"
      :disabled="isRadio || !hasPlayable || !playbackStore.hasNext"
      :title="titles.next"
      :aria-label="titles.next"
      @click="playbackStore.playNext()"
    />
    <v-btn
      :icon="repeatIcon"
      :color="!isRadio && playbackStore.repeatMode !== 'off' ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :disabled="isRadio"
      :title="titles.repeat"
      :aria-label="titles.repeat"
      @click="playbackStore.cycleRepeatMode()"
    />
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { withShortcut } from '@/services/keyboardShortcuts'

const REPEAT_LABELS = {
  off: 'player.repeatOff',
  all: 'player.repeatAll',
  one: 'player.repeatOne',
} as const

export default {
  name: 'CenterControls',
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    hasPlayable() {
      return this.playbackStore.currentSong != null || this.playbackStore.radioStation != null
    },
    isRadio() {
      return this.playbackStore.radioStation != null
    },
    repeatIcon() {
      return this.playbackStore.repeatMode === 'one' ? 'mdi-repeat-once' : 'mdi-repeat'
    },
    /** Hover text, with the key that does the same. Repeat names its mode:
     * off and all differ only in colour otherwise. */
    titles() {
      const playback = this.playbackStore
      return {
        shuffle: withShortcut(this.$t('player.shuffle'), 'toggleShuffle'),
        previous: withShortcut(this.$t('player.previous'), 'previousTrack'),
        play: withShortcut(
          this.$t(playback.isPlaying ? 'player.pause' : 'player.play'),
          'togglePlay',
        ),
        next: withShortcut(this.$t('player.next'), 'nextTrack'),
        repeat: withShortcut(this.$t(REPEAT_LABELS[playback.repeatMode]), 'cycleRepeat'),
      }
    },
  },
}
</script>

<style scoped>
.center-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Filled, inverted-color circle — reads as "the" button at a glance next
 * to the flanking transport buttons' plain outlined icons. */
.play-btn :deep(.v-icon) {
  color: rgb(var(--v-theme-background));
}

/* Set apart from the skip buttons flanking it. 40px rather than the 44px
 * Vuetify's large size gives: at 44 the amber disc outweighed the bar. */
.play-btn {
  margin-inline: 4px;
  width: 40px;
  height: 40px;
}
</style>
