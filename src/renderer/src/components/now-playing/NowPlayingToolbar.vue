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
  <!-- `defer` resolves the target after this render, so the guest page's
   - header (rendered in the same pass as this toolbar, unlike the app's
   - separate app-bar component) is in the document by then. -->
  <Teleport to="#mobile-app-bar-actions" :disabled="!compact || !canDock" defer>
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
        :color="source.ui.lyricsOpen ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="isRadio ? $t('radio.titleLog') : $t('lyrics.title')"
        @click="source.setLyricsOpen(!source.ui.lyricsOpen)"
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
        v-if="isFullscreen && source.capabilities.autoplay"
        icon="mdi-infinity"
        :color="!source.radio && source.autoplayEnabled() ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :disabled="!!source.radio"
        :title="$t('player.autoplay')"
        @click="source.toggleAutoplay()"
      />
      <!-- Hidden rather than disabled where there is nothing to visualize: a
       - phone plays without a Web Audio graph so that it keeps going while
       - the screen is locked (see services/audioEngine.ts), and a control
       - that could only ever produce empty bars is worse than no control.
       - Still there while casting, whose data comes from the backend
       - instead. -->
      <v-btn
        v-if="source.visualizer.available"
        icon="mdi-equalizer"
        :color="source.ui.showVisualizer ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="source.toggleVisualizer()"
      />
      <!-- Brings the album artwork back, large, over the artist background.
       - Only once there is a background loaded: without one the artwork is
       - already what the stage shows, so there is nothing to toggle. Lit
       - while the artwork is the thing on screen, like the other toggles. -->
      <v-btn
        v-if="source.backdrop.isArtist"
        icon="mdi-album"
        :color="!source.ui.artworkHidden ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleArtwork')"
        @click="source.toggleArtwork()"
      />
      <!-- Steps to the artist's next Fanart.tv background. Only when there
       - is more than one to step through - with a single image the button
       - would do nothing. -->
      <v-btn
        v-if="source.backdrop.backgrounds.length > 1"
        icon="mdi-wallpaper"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.nextBackground')"
        @click="source.cycleBackground()"
      />
      <!-- Not a mobile feature — MobileTransportControls.vue/the tab bar
       - already own the phone's actual full screen; hiding *that* app chrome
       - behind the Fullscreen API here wouldn't gain anything and isn't what
       - "fullscreen" reads as on a phone anyway. -->
      <v-btn
        v-if="!compact && source.capabilities.fullscreen"
        :icon="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
        :color="isFullscreen ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleFullscreen')"
        @click="$emit('toggle-fullscreen')"
      />
      <!-- A party guest's own control (the skip vote) goes here. -->
      <slot />
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
        v-if="source.capabilities.debug && source.radio"
        icon="mdi-playlist-plus"
        variant="text"
        density="comfortable"
        title="Debug: add a made-up title"
        @click="source.addDebugTitle?.()"
      />
    </div>
  </Teleport>
</template>

<script lang="ts">
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'

export default {
  name: 'NowPlayingToolbar',
  mixins: [nowPlayingSourceMixin],
  props: {
    compact: {
      type: Boolean,
      default: false,
    },
    /** Fullscreen is the presentation's own concern (it owns the element),
     * so it is passed in rather than read from the source. */
    isFullscreen: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['toggle-fullscreen'],
  data() {
    return {
      /** Whether MobileLayout.vue's app bar is on the page to hang the
       * toolbar in — see the Teleport. Checked rather than assumed: this
       * component is also mounted on its own, outside any shell. */
      canDock: false,
    }
  },
  computed: {
    hasPlayable(): boolean {
      return this.source.song != null || this.source.radio != null
    },
    /** Radio with no track of its own: the lyrics button becomes the title
     * log's switch. */
    isRadio(): boolean {
      return this.source.radio != null && this.source.song == null
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
  mounted() {
    // The guest page renders its header in the same pass as this toolbar
    // (there is no separate app-bar component ahead of a router view), so
    // the target can miss the created() check; look again once mounted, and
    // the Teleport docks on the re-render.
    if (!this.canDock) {
      this.canDock = document.getElementById('mobile-app-bar-actions') !== null
    }
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
  /* The guest's skip vote is a text button, taller than an icon button; the
   * row centres every button on a common line rather than top-aligning the
   * shorter ones. */
  align-items: center;
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
   * instead of staying clear of it in the corner. (Both the app and the
   * guest page dock the toolbar into their app bar, so this is only the
   * fallback where there is no bar to dock into.) */
  flex-direction: column;
}
</style>
