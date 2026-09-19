<template>
  <v-bottom-navigation
    app
    grow
    density="comfortable"
    color="primary"
    :height="BAR_HEIGHT + gestureGap"
    :model-value="activeTab"
    :style="{ '--mobile-tabbar-gap': `${gestureGap}px` }"
    class="mobile-tabbar"
  >
    <v-btn v-for="item in items" :key="item.to" :value="item.to" @click="$router.push(item.to)">
      <v-icon :icon="item.icon" />
      <span class="mobile-tabbar__label">{{ item.label }}</span>
    </v-btn>
  </v-bottom-navigation>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'

// Vuetify's own default for this bar. `density="comfortable"` takes 8 off
// whatever is passed, so the buttons themselves sit in 48px either way.
const BAR_HEIGHT = 56

/** Strip left empty below the buttons, added to the bar's height rather
 * than taken out of it so the touch targets keep their full 48px.
 *
 * Only where the bar really is at the bottom edge of the screen (see
 * atScreenEdge): that is where both phone platforms listen for their own
 * swipe-up gesture, and a tap in a button's lower half was as likely to
 * send the app to the background as to switch tabs.
 *
 * A plain number, not env(safe-area-inset-bottom): the inset reads as 0
 * without `viewport-fit=cover` on the viewport meta, which this app
 * deliberately does not set (it would push the app bar under the status bar
 * too). This is also a different quantity - the gesture strip is a hazard
 * for our own touch targets, where the safe-area inset describes what the
 * OS draws over. */
const GESTURE_GAP = 20

/** The display modes in which nothing of the browser's own sits below us.
 * In an ordinary tab the browser's toolbar is down there instead of the
 * gesture strip, and the gap would be a band of dead space above it. */
const AT_SCREEN_EDGE =
  '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)'

/** ...and the gesture strip itself only exists where the screen is the
 * input. The mobile shell is chosen on viewport width alone
 * (useIsMobileWeb.ts), so the installed desktop PWA lands in it too once
 * its window is dragged under 960px - standalone, at the screen edge, and
 * with nothing down there to swipe. Kept as its own query rather than
 * folded into the list above, which would need the `or` of Media Queries 4
 * and fail silently to "never matches" wherever that is not understood. */
const TOUCH_INPUT = '(pointer: coarse)'

export default {
  name: 'MobileTabBar',
  data() {
    return {
      BAR_HEIGHT,
      atScreenEdge: false,
      edgeQuery: null as MediaQueryList | null,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    gestureGap(): number {
      return this.atScreenEdge ? GESTURE_GAP : 0
    },
    items() {
      return [
        {
          to: '/m/now-playing',
          icon: 'mdi-play-circle-outline',
          label: this.$t('mobile.tabNowPlaying'),
        },
        { to: '/m/queue', icon: 'mdi-playlist-music', label: this.$t('mobile.tabQueue') },
        { to: '/m/playlists', icon: 'mdi-playlist-play', label: this.$t('nav.playlists') },
        { to: '/m/library', icon: 'mdi-music-note', label: this.$t('nav.library') },
        this.authStore.capabilities.internetRadio
          ? { to: '/m/radio', icon: 'mdi-radio', label: this.$t('nav.radio') }
          : null,
      ].filter((item): item is { to: string; icon: string; label: string } => item !== null)
    },
    /** Which tab is lit, or null on a sub-page like /m/albums/:id - only
     * the exact tab routes light up, rather than guessing which parent tab
     * a sub-page "belongs" to.
     *
     * Bound as the group's own v-model rather than as each button's
     * `active`: VBtn takes the `v-btn--active` class from `active` but its
     * *colour* from the group's selection (see showColor in VBtn.js), and
     * with nothing driving the group the last tab tapped stayed coloured
     * for good - opening an album from Now Playing left that tab lit in
     * the library.
     *
     * null, not undefined, or Vue drops the binding and the prop falls
     * back to its own default. */
    activeTab(): string | null {
      const path = this.$route.path
      return this.items.some((item) => item.to === path) ? path : null
    },
  },
  // Watched rather than read once: installing the app from the tab it is
  // already running in switches the mode under a live page.
  mounted() {
    if (typeof window.matchMedia !== 'function') return
    this.edgeQuery = window.matchMedia(AT_SCREEN_EDGE)
    this.edgeQuery.addEventListener('change', this.updateScreenEdge)
    this.updateScreenEdge()
  },
  beforeUnmount() {
    this.edgeQuery?.removeEventListener('change', this.updateScreenEdge)
  },
  methods: {
    updateScreenEdge() {
      this.atScreenEdge =
        (this.edgeQuery?.matches ?? false) && window.matchMedia(TOUCH_INPUT).matches
    },
  },
}
</script>

<style scoped>
.mobile-tabbar {
  border-top: 1px solid var(--beacon-hairline);
  /* Fed by the same constant that grew the bar (see GESTURE_GAP), so the
   * two cannot drift apart into either a squeezed button row or no gap. */
  padding-bottom: var(--mobile-tabbar-gap);
}

/* Vuetify gives each button a min-width of 80px and `grow` only ever
 * stretches them, never shrinks. Five tabs are 400px, which is wider than
 * every common phone: the row centred itself and hung 5px off each end at
 * 390px, more on a narrower screen, so the last tab (Radio) was the one
 * with a slice missing and a shrunken touch target. Sharing the bar
 * equally instead is what `grow` reads as anyway. */
.mobile-tabbar :deep(.v-btn) {
  min-width: 0;
  flex: 1 1 0;
  /* Vuetify's own 16px of side padding is a third of a tab at 320px, and it
   * is padding around a centred icon and label that need none — the label
   * gets that width instead. */
  padding-inline: 2px;
}

/* The ellipsis below only works once the label has a width to be capped
 * against: `max-width: 100%` resolves against Vuetify's .v-btn__content,
 * which has none of its own and grows with the text instead. A label longer
 * than its fifth of the bar (German's "Warteschlange", French's "File
 * d'attente") therefore overflowed the button and was clipped mid-word at
 * both ends. */
.mobile-tabbar :deep(.v-btn__content) {
  min-width: 0;
  max-width: 100%;
}

.mobile-tabbar__label {
  font-size: 0.65rem;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
