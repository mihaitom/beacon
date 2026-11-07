<template>
  <v-app>
    <!-- The only way to reach /settings (logout, language, ...) from the
     - mobile shell — none of the five tabs cover it. Shown on every route,
     - including Now Playing, so it doesn't depend on playback state (that
     - view's own toolbar only renders at all once something's playing). -->
    <!-- 56, not the 44 this started at: the bar carries the current view's
       - own actions now (see the actions slot below), and an icon button in
       - a 44px bar sat with barely a pixel of air above and below it.
       -
       - No `density` prop either — Vuetify's compact density overrode the
       - height outright rather than adjusting it, leaving the bar at 41px
       - however large the number here said. -->
    <!-- Both bars step aside on Now Playing while the phone is on its
       - side: together they are a third of its height. Hidden rather than
       - removed, so the toolbar's dock target stays in the document. -->
    <v-app-bar height="56" color="chrome" class="mobile-app-bar" :model-value="!immersive">
      <!-- Same size as every other icon in this bar. It was 16 while the
         - bar held nothing but a title; sitting next to 24px buttons it
         - just read as a small version of them. -->
      <v-icon
        icon="mdi-lighthouse-on"
        color="primary"
        size="24"
        class="mobile-app-bar__logo beacon-glow"
      />
      <v-app-bar-title class="mobile-app-bar__title">Beacon</v-app-bar-title>
      <v-spacer />
      <!-- Where a view can hang its own actions instead of floating them
         - over its content. Now Playing is the one that does (see
         - NowPlayingView.vue's toolbar Teleport): its two buttons used to
         - sit in the top-right corner of the artwork, which only worked
         - while the artwork was small enough to leave a corner free. -->
      <span id="mobile-app-bar-actions" class="mobile-app-bar__actions" />
      <!-- Party, equalizer and settings share one menu: next to the
         - buttons Now Playing hangs in above, each as its own icon pushed the
         - app's name down to "B...". The dot is the settings one (see
         - DefaultLayout.vue's settings entry), shown where it can be seen. -->
      <v-menu location="bottom end">
        <template #activator="{ props: menuProps }">
          <v-btn
            icon
            variant="text"
            density="comfortable"
            class="mobile-app-bar__action"
            :aria-label="$t('common.moreActions')"
            v-bind="menuProps"
          >
            <v-badge
              dot
              color="primary"
              :model-value="updateStore.unseen"
              :label="$t('settings.updateBadge')"
            >
              <v-icon icon="mdi-dots-vertical" />
            </v-badge>
          </v-btn>
        </template>
        <v-list density="compact">
          <!-- On every route: the party is this window's, whatever the
             - phone happens to be showing. -->
          <v-list-item
            prepend-icon="mdi-party-popper"
            :base-color="partyStore.enabled ? 'primary' : undefined"
            :title="$t('party.title')"
            @click="showPartyDialog = true"
          >
            <template v-if="partyGuests > 0" #append>
              <v-badge inline :content="partyGuests" color="primary" />
            </template>
          </v-list-item>
          <!-- Only while casting: a phone plays without a Web Audio graph,
             - so the speaker's curve is the only one there is to set. -->
          <v-list-item
            v-if="casting"
            prepend-icon="mdi-tune-vertical"
            :title="$t('equalizer.title')"
            @click="showEqualizerDialog = true"
          />
          <v-list-item
            prepend-icon="mdi-cog-outline"
            :title="$t('nav.settings')"
            @click="$router.push('/settings')"
          >
            <template v-if="updateStore.unseen" #append>
              <v-badge dot inline color="primary" :label="$t('settings.updateBadge')" />
            </template>
          </v-list-item>
        </v-list>
      </v-menu>
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>

    <!-- Registration order matters for Vuetify's app-layout stacking —
     - whichever `app` item mounts *first* lands at the true edge (bottom: 0
     - in Vuetify's own generateLayers(), see composables/layout.js), and
     - each one after that stacks further out. mobile-tab-bar has to come
     - first so it's the one actually touching the bottom edge/safe area,
     - with mobile-player-bar's mini strip docking above it — not the other
     - way around. Only shown off the Now Playing tab itself, where the full
     - transport controls already cover the same ground (see
     - MobileNowPlayingView.vue). -->
    <mobile-tab-bar :active="!immersive" />
    <mobile-player-bar v-if="!onNowPlaying" />
    <cast-takeover-confirm-dialog />
    <party-mode-dialog v-model="showPartyDialog" />
    <equalizer-dialog v-if="casting" v-model="showEqualizerDialog" compact />
  </v-app>
</template>

<script lang="ts">
import MobileTabBar from '@/components/mobile/MobileTabBar.vue'
import MobilePlayerBar from '@/components/mobile/MobilePlayerBar.vue'
import CastTakeoverConfirmDialog from '@/components/connect/CastTakeoverConfirmDialog.vue'
import PartyModeDialog from '@/components/party/PartyModeDialog.vue'
import EqualizerDialog from '@/components/equalizer/EqualizerDialog.vue'
import { phoneLandscapeMixin } from '@/composables/phoneLandscape'
import { useUpdateStore } from '@/stores/update'
import { useConnectStore } from '@/stores/connect'
import { usePartyStore } from '@/stores/party'

/** Roughly how long iOS takes to animate a rotation; the reset is repeated
 * after it in case the offset is only applied at its end. */
const ROTATION_SETTLE_MS = 500

export default {
  name: 'MobileLayout',
  components: {
    MobileTabBar,
    MobilePlayerBar,
    CastTakeoverConfirmDialog,
    EqualizerDialog,
    PartyModeDialog,
  },
  mixins: [phoneLandscapeMixin],
  data() {
    return {
      scrollResetTimer: null as ReturnType<typeof setTimeout> | null,
      showPartyDialog: false,
      showEqualizerDialog: false,
    }
  },
  computed: {
    updateStore() {
      return useUpdateStore()
    },
    partyStore() {
      return usePartyStore()
    },
    /** Guests with the party page open right now, as PartyModeButton.vue
     * counts them. */
    partyGuests(): number {
      return this.partyStore.hostedHere ? this.partyStore.connectedGuests : 0
    },
    casting(): boolean {
      return useConnectStore().isActive
    },
    onNowPlaying() {
      return this.$route.name === 'm-now-playing'
    },
    /** Now Playing on a phone held sideways gets the whole screen. */
    immersive(): boolean {
      return this.onNowPlaying && this.phoneLandscape
    },
  },
  // On <html> rather than in a scoped block: the rules below have to reach
  // the document itself, and only while this shell is the one on screen -
  // the desktop app scrolls its own pages normally.
  //
  // Before mount, not on it: children mount first, and a virtualized list
  // looks for its scrolling parent as it does - without the class, the
  // pane isn't one yet and the list attaches to the document, which never
  // scrolls here.
  beforeMount() {
    document.documentElement.classList.add('mobile-shell')
  },
  mounted() {
    window.addEventListener('resize', this.resetDocumentScroll)
  },
  beforeUnmount() {
    document.documentElement.classList.remove('mobile-shell')
    window.removeEventListener('resize', this.resetDocumentScroll)
    if (this.scrollResetTimer) clearTimeout(this.scrollResetTimer)
  },
  methods: {
    /** Installed to the home screen, iOS keeps the upright status bar's
     * 47px as the document's scroll offset after the phone turns, while
     * reporting scrollY 0 (measured on the phone: a tap's pageY was its
     * clientY - 47): the page was drawn that far down, and taps were
     * hit-tested 47px above the finger. The document never scrolls on its
     * own here (see the rules below), so nothing reset it - this does, once
     * the rotation has settled. Only a real iPhone shows it; no desktop
     * browser's emulation does. */
    resetDocumentScroll(): void {
      if (this.scrollResetTimer) clearTimeout(this.scrollResetTimer)
      requestAnimationFrame(() => window.scrollTo(0, 0))
      this.scrollResetTimer = setTimeout(() => window.scrollTo(0, 0), ROTATION_SETTLE_MS)
    },
  },
}
</script>

<style>
/* The page itself must not scroll on a phone; the content between the two
 * bars does.
 *
 * Every mobile view is a plain block that grows with its content, so the
 * document was the scroller - and the two bars hang off Vuetify's layout
 * with `position: fixed`, which iOS pins to the *layout* viewport rather
 * than to what is on screen. Installed as a PWA that came apart: reported
 * 2026-09-07 as the tab bar travelling up the screen while scrolling and
 * then staying in the middle of it.
 *
 * Nothing here is a workaround for that one browser - a shell with fixed
 * chrome and one scrolling pane between it is what this layout has always
 * meant, and the document scrolling underneath it was accidental. */
html.mobile-shell,
html.mobile-shell body {
  height: 100%;
  overflow: hidden;
}

/* Sticky headers clamp against the pane below, which already starts below
 * the app bar - offsetting them by its height again (the desktop's own
 * --v-layout-top) left a strip above them with rows scrolling through it.
 * See StickyFilter.vue. */
html.mobile-shell {
  --beacon-sticky-top: 0px;
}

/* dvh, with vh under it for engines that know neither: this box sits
 * *between* the bars rather than behind them, so it wants the viewport as
 * it currently is. Where a browser gets dvh wrong the bars stay put
 * regardless - only this pane is then a little too tall or short, which
 * costs a few pixels of scroll rather than the layout. */
html.mobile-shell .v-main {
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  /* A flick that reaches the end of the list stays in the list instead of
   * pulling the page behind it. */
  overscroll-behavior: contain;
}
</style>

<style scoped>
.mobile-app-bar__logo {
  margin-inline-start: 12px;
  margin-inline-end: 8px;
}

.mobile-app-bar__actions {
  display: flex;
  align-items: center;
}

.mobile-app-bar {
  border-bottom: 1px solid var(--beacon-hairline);
}

.mobile-app-bar__title {
  font-weight: 600;
  font-size: 0.95rem;
}

.beacon-glow {
  filter: drop-shadow(0 0 6px rgba(var(--v-theme-primary), 0.55));
}

.mobile-app-bar__action {
  margin-right: 4px;
}
</style>
