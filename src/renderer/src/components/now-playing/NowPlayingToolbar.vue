<template>
  <!-- On the phone these move into the app bar rather than floating over the
   - artwork (see MobileLayout.vue's #mobile-app-bar-actions). Teleported
   - rather than duplicated in MobileLayout.vue: which buttons apply, and what
   - each of them does, is this view's business, and none of it belongs in the
   - shell.
   -
   - `disabled` on desktop, where the toolbar stays exactly where it was:
   - there is no such target in DefaultLayout, and in fullscreen only the
   - Now Playing subtree is shown, so anything hung outside it would vanish at
   - the moment it is most needed. Also disabled wherever the target simply is
   - not there — the view is mounted on its own in tests, and a Teleport
   - pointed at nothing does not degrade, it throws on unmount. -->
  <Teleport to="#mobile-app-bar-actions" :disabled="!compact || !canDock">
    <div
      v-if="hasPlayable"
      class="now-playing__toolbar"
      :class="{
        'now-playing__toolbar--docked': docked,
        'now-playing__toolbar--compact': compact && !docked,
      }"
    >
      <!-- The only lyrics button in the app, on every layout. It used to be
       - shown here just in fullscreen (which shows nothing but the Now
       - Playing subtree) and on the phone (MobileTransportControls.vue has no
       - equivalent), standing in for PlayerBar.vue's own copy the rest of the
       - time — but the lyrics, and a station's title log in their place, now
       - only ever appear on this screen, so the switch for them belongs on it
       - rather than in the chrome of every other page. -->
      <v-btn
        v-if="hasPlayable"
        :icon="isRadio ? 'mdi-history' : 'mdi-script-text-outline'"
        :color="showLyrics ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="isRadio ? $t('radio.titleLog') : $t('lyrics.title')"
        @click="drawersStore.lyricsPanelOpen = !showLyrics"
      />
      <!-- PlayerBar.vue's own Autoplay button (next to Queue) is outside
       - .now-playing entirely, so it's unreachable in fullscreen, making this
       - the only way to reach it there. Not shown outside fullscreen, where
       - PlayerBar's own button already covers it, and not on the phone
       - either: that one has its own copy in the transport row
       - (MobileTransportControls.vue), next to shuffle.
       -
       - Disabled during radio for the reason PlayerBar's copy gives: there is
       - no queue for autoplay to top up while a live stream plays. -->
      <v-btn
        v-if="isFullscreen && authStore.capabilities.songRadio"
        icon="mdi-infinity"
        :color="!radioStation && autoplayStore.enabled ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :disabled="!!radioStation"
        :title="$t('player.autoplay')"
        @click="playbackStore.setAutoplayEnabled(!autoplayStore.enabled)"
      />
      <!-- Hidden rather than disabled where there is nothing to visualize: a
       - phone plays without a Web Audio graph so that it keeps going while
       - the screen is locked (see services/audioEngine.ts), and a control
       - that could only ever produce empty bars is worse than no control.
       - Still there while casting, whose data comes from the backend
       - instead. -->
      <v-btn
        v-if="visualizerAvailable"
        icon="mdi-equalizer"
        :color="showVisualizer ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="$emit('toggle-visualizer')"
      />
      <!-- Only once there is a Fanart.tv artist background loaded and ready:
       - hiding the artwork with nothing behind it would just leave a blank
       - stage. Hiding it drops the darkening too, so the background is
       - actually visible. -->
      <v-btn
        v-if="artistBackground"
        icon="mdi-image-off-outline"
        :color="artworkHidden ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleArtwork')"
        @click="$emit('toggle-artwork')"
      />
      <!-- Not a mobile feature — MobileTransportControls.vue/the tab bar
       - already own the phone's actual full screen; hiding *that* app chrome
       - behind the Fullscreen API here wouldn't gain anything and isn't what
       - "fullscreen" reads as on a phone anyway. -->
      <v-btn
        v-if="!compact"
        :icon="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
        :color="isFullscreen ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleFullscreen')"
        @click="$emit('toggle-fullscreen')"
      />
      <!-- A test bench for the title log's entrance animation: a station
       - changes title every few minutes, which is a long wait to watch a
       - three-tenths-of-a-second transition. Each press hands the log one
       - made-up title at the top, through the same prop a real one arrives
       - on, so what is being watched is the real path and not a rehearsal of
       - it.
       -
       - Renderer-only: the entry is never sent anywhere, never reaches the
       - station's stored log (connect/core/session.py keeps that one) and is
       - gone on the next reload or station change. And only ever while the
       - backend's log level is DEBUG or TRACE, the same switch
       - VisualizerDebugOverlay.vue hides behind. -->
      <v-btn
        v-if="debugEnabled && radioStation"
        icon="mdi-playlist-plus"
        variant="text"
        density="comfortable"
        title="Debug: add a made-up title"
        @click="$emit('add-debug-title')"
      />
    </div>
  </Teleport>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'

export default {
  name: 'NowPlayingToolbar',
  props: {
    compact: {
      type: Boolean,
      default: false,
    },
    isFullscreen: {
      type: Boolean,
      default: false,
    },
    showVisualizer: {
      type: Boolean,
      default: false,
    },
    visualizerAvailable: {
      type: Boolean,
      default: false,
    },
    /** The loaded Fanart.tv background; the artwork toggle only appears once
     * there is something to reveal. */
    artistBackground: {
      type: String as () => string | null,
      default: null,
    },
    artworkHidden: {
      type: Boolean,
      default: false,
    },
    debugEnabled: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['toggle-visualizer', 'toggle-artwork', 'toggle-fullscreen', 'add-debug-title'],
  data() {
    return {
      /** Whether MobileLayout.vue's app bar is on the page to hang the
       * toolbar in — see the Teleport. Checked rather than assumed: this
       * component is also mounted on its own, outside any shell. */
      canDock: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    drawersStore() {
      return useDrawersStore()
    },
    authStore() {
      return useAuthStore()
    },
    autoplayStore() {
      return useAutoplayStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    radioStation() {
      return this.playbackStore.radioStation
    },
    hasPlayable(): boolean {
      return this.currentSong != null || this.radioStation != null
    },
    showLyrics(): boolean {
      return this.drawersStore.lyricsPanelOpen
    },
    /** Radio with no track of its own: the lyrics button becomes the title
     * log's switch. */
    isRadio(): boolean {
      return this.radioStation != null && this.currentSong == null
    },
    docked(): boolean {
      return this.compact && this.canDock
    },
  },
  created() {
    // Already there in the real shell: MobileLayout renders its app bar
    // before <router-view>, so the target is in the document by the time
    // this gets here — checking now rather than in mounted() keeps the
    // toolbar from rendering over the artwork for a frame first.
    this.canDock = document.getElementById('mobile-app-bar-actions') !== null
  },
}
</script>

<style scoped>
.now-playing__toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 2;
  display: flex;
  gap: 4px;
  /* A translucent panel under the icons: with the artwork hidden they sit
   * directly on the artist photo, where a plain white icon can vanish. */
  padding: 4px;
  border-radius: 999px;
  background: rgba(18, 20, 28, 0.55);
  backdrop-filter: blur(8px);
}

/* Teleported into the app bar: it is a row of buttons in a bar now, not an
 * overlay on artwork, so everything that made it float comes back off. */
.now-playing__toolbar--docked {
  position: static;
  z-index: auto;
  flex-direction: row;
  gap: 0;
  padding: 0;
  border-radius: 0;
  background: none;
  backdrop-filter: none;
}

.now-playing__toolbar--compact {
  top: 8px;
  right: 8px;
  /* Stacked, not a row — a phone screen is narrow enough that even two icon
   * buttons side by side reached noticeably into the artwork underneath
   * instead of staying clear of it in the corner. */
  flex-direction: column;
}
</style>
