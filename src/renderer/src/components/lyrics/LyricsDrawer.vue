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
    :width="DRAWER_WIDTH"
    temporary
    persistent
    :scrim="false"
    color="#0B0D13"
    class="beacon-drawer"
    :style="{ insetInlineEnd: sideBySideOffset }"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column fill-height">
      <v-toolbar
        density="compact"
        color="#0B0D13"
        class="beacon-drawer__toolbar"
        :title="drawerTitle"
      />

      <lyrics-panel v-if="currentSong" variant="compact" class="flex-grow-1" />
      <!-- A radio station never has lyrics, which leaves this whole panel
         - empty for as long as one plays. What it does have is a running
         - list of what it has played (stores/playback.ts's radioTitleLog),
         - and this is the space to read it in. -->
      <radio-title-log
        v-else-if="radioStation"
        :entries="playbackStore.radioTitleLog"
        class="beacon-drawer__log"
      />
      <v-list-item v-else>
        <span class="text-medium-emphasis text-body-medium">{{
          $t('nowPlaying.nothingPlaying')
        }}</span>
      </v-list-item>
    </div>
  </v-navigation-drawer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'

// Shared with QueueDrawer.vue, which is the same width by design: the two
// sit side by side when both are open (see sideBySideOffset), and that
// only lines up if the offset matches the other one's width exactly.
const DRAWER_WIDTH = 380
import { useLyricsStore } from '@/stores/lyrics'
import LyricsPanel from './LyricsPanel.vue'
import RadioTitleLog from '@/components/radio/RadioTitleLog.vue'

export default {
  name: 'LyricsDrawer',
  components: { LyricsPanel, RadioTitleLog },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  computed: {
    DRAWER_WIDTH: () => DRAWER_WIDTH,
    playbackStore() {
      return usePlaybackStore()
    },
    drawersStore() {
      return useDrawersStore()
    },
    /** Slides this one clear of the queue when both are open, instead of
     * the two stacking invisibly on top of each other — whichever was
     * rendered last simply covered the other, and closing it revealed a
     * drawer the user had no reason to expect. The queue keeps the outer
     * edge because it is the one people leave open. */
    sideBySideOffset(): string {
      return this.drawersStore.queueDrawerOpen ? `${DRAWER_WIDTH}px` : '0px'
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    radioStation() {
      return this.playbackStore.radioStation
    },
    /** The panel is the same drawer either way, but what it holds is not
     * a song text while radio plays — naming it "Lyrics" over a list of
     * broadcast titles would just be wrong. */
    drawerTitle(): string {
      return this.radioStation && !this.currentSong
        ? this.$t('radio.titleLog')
        : this.$t('lyrics.title')
    },
  },
  watch: {
    // Loads on open, and again on every song change while the drawer's
    // already open — see stores/lyrics.ts's ensureLoaded() for why this
    // isn't triggered eagerly from the playback store itself instead
    // (avoids hitting three uncached third-party APIs for songs nobody's
    // actually looking at lyrics for).
    //
    // immediate, because the *first* opening is not a change this watcher
    // can see: DefaultLayout.vue doesn't create this component until the
    // moment the drawer is first opened (v-if="lyricsDrawerEverOpened", so
    // nothing flashes at app start), which means modelValue is already true
    // on its very first render. Without this, the first open of a session
    // asked for nothing and sat there claiming the song had no lyrics —
    // until something else, in practice opening the Now Playing view, went
    // and loaded them (its own currentSong watcher is immediate for a
    // related reason). Every later open toggles the prop normally and would
    // have worked either way.
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open && this.currentSong) useLyricsStore().ensureLoaded(this.currentSong)
      },
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

/* Takes the height the toolbar above it leaves, and no more — min-height
 * because a flex child otherwise refuses to shrink below its own content,
 * which is what kept the log from ever scrolling inside the drawer. */
.beacon-drawer__log {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
