<template>
  <v-app class="guest-app">
    <div v-if="store.phase === 'loading'" class="guest-app__center">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <div v-else-if="store.phase === 'message'" class="guest-app__center">
      <v-icon icon="mdi-lighthouse-on" color="primary" size="56" />
      <h1 class="display-title">{{ $t(`partyGuest.${store.message}Title`) }}</h1>
      <p class="text-body-medium text-medium-emphasis">
        {{ $t(`partyGuest.${store.message}Text`) }}
      </p>
    </div>

    <div v-else-if="store.phase === 'join'" class="guest-app__center">
      <v-icon icon="mdi-party-popper" color="primary" size="56" />
      <h1 class="display-title">{{ $t('partyGuest.joinTitle') }}</h1>
      <p class="text-body-medium text-medium-emphasis">{{ $t('partyGuest.joinText') }}</p>
      <form class="guest-app__join" @submit.prevent="join">
        <v-text-field
          v-model="name"
          :placeholder="$t('partyGuest.namePlaceholder')"
          variant="solo-filled"
          maxlength="24"
          autocomplete="nickname"
          autofocus
          hide-details
        />
        <v-btn
          type="submit"
          color="primary"
          size="large"
          :loading="joining"
          :disabled="!name.trim()"
        >
          {{ $t('partyGuest.join') }}
        </v-btn>
      </form>
      <p v-if="joinError" class="text-body-medium text-error">{{ joinError }}</p>
    </div>

    <!-- A phone: the mobile app's shape - one page at a time, tab bar at
     - the bottom. -->
    <template v-else-if="compact">
      <header class="guest-app__bar">
        <v-icon icon="mdi-lighthouse-on" color="primary" />
        <span class="guest-app__brand">Beacon</span>
        <span class="text-body-small text-medium-emphasis guest-app__me">{{ meName }}</span>
        <!-- The shared Now Playing toolbar teleports its buttons in here on
         - a phone, as it does into MobileLayout.vue's own app bar. -->
        <span id="mobile-app-bar-actions" class="guest-app__actions" />
      </header>
      <main class="guest-app__page" :class="{ 'guest-app__page--flush': tab === 'now' }">
        <now-playing-presentation v-if="tab === 'now'" compact>
          <template #toolbar-actions>
            <guest-skip-button @notify="notify" />
          </template>
        </now-playing-presentation>
        <guest-radio-hint v-else-if="radio" />
        <guest-queue v-else-if="tab === 'queue'" @notify="notify" />
        <guest-wish v-else @notify="notify" />
      </main>
      <v-bottom-navigation v-model="tab" grow color="primary" class="guest-app__tabs" mandatory>
        <v-btn value="now" prepend-icon="mdi-play-circle-outline" stacked>
          {{ $t('partyGuest.tabNow') }}
        </v-btn>
        <v-btn value="queue" prepend-icon="mdi-playlist-music" stacked>
          {{ $t('partyGuest.tabQueue') }}
        </v-btn>
        <v-btn value="wish" prepend-icon="mdi-magnify" stacked>
          {{ $t('partyGuest.tabWish') }}
        </v-btn>
      </v-bottom-navigation>
    </template>

    <!-- A larger screen: Now Playing as the stage, what's next and the
     - search beside it. -->
    <div v-else class="guest-app__desktop">
      <now-playing-presentation class="guest-app__stage">
        <template #toolbar-actions>
          <guest-skip-button @notify="notify" />
        </template>
      </now-playing-presentation>
      <aside class="guest-app__side">
        <header class="guest-app__side-head">
          <v-icon icon="mdi-lighthouse-on" color="primary" />
          <span class="guest-app__brand">Beacon</span>
          <span class="text-body-small text-medium-emphasis guest-app__me">{{ meName }}</span>
        </header>
        <v-tabs
          v-model="sideTab"
          color="primary"
          grow
          :disabled="radio"
          class="guest-app__side-tabs"
        >
          <v-tab value="queue">{{ $t('partyGuest.tabQueue') }}</v-tab>
          <v-tab value="wish">{{ $t('partyGuest.tabWish') }}</v-tab>
        </v-tabs>
        <div class="guest-app__side-body">
          <guest-radio-hint v-if="radio" />
          <guest-queue v-else-if="sideTab === 'queue'" @notify="notify" />
          <guest-wish v-else @notify="notify" />
        </div>
      </aside>
    </div>

    <v-snackbar v-model="toastOpen" :timeout="3500" location="bottom">{{ toast }}</v-snackbar>
  </v-app>
</template>

<script lang="ts">
import { usePartyGuestStore } from './store'
import { PartyApiError } from './api'
import { guestErrorKey } from './errors'
import { useGuestNowPlayingSource } from './guestSource'
import { nowPlayingSourceKey } from '@/components/now-playing/source'
import NowPlayingPresentation from '@/components/now-playing/NowPlayingPresentation.vue'
import GuestSkipButton from './components/GuestSkipButton.vue'
import GuestQueue from './components/GuestQueue.vue'
import GuestRadioHint from './components/GuestRadioHint.vue'
import GuestWish from './components/GuestWish.vue'

export default {
  name: 'PartyGuestApp',
  components: { NowPlayingPresentation, GuestSkipButton, GuestQueue, GuestRadioHint, GuestWish },
  provide() {
    // The shared Now Playing presentation reads this instead of any store,
    // so guests and the host render the same components.
    return { [nowPlayingSourceKey]: this.guestNp.source }
  },
  data() {
    return {
      // The guest's own Now Playing source, and everything behind it (view
      // preferences, colour extraction, the visualizer feed). A phone has no
      // room for the corner's next-up card, as in the app.
      guestNp: useGuestNowPlayingSource({
        isCompact: () => Boolean((this as unknown as { compact: boolean }).compact),
      }),
      name: usePartyGuestStore().savedName,
      joining: false,
      joinError: '',
      tab: 'now',
      sideTab: 'queue',
      toast: '',
      toastOpen: false,
    }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
    /** The app's own phone breakpoint (useIsMobileWeb's). */
    compact(): boolean {
      return this.$vuetify.display.smAndDown
    },
    radio(): boolean {
      return Boolean(this.store.snapshot?.radio)
    },
    meName(): string {
      return this.store.snapshot?.me.name ?? ''
    },
  },
  mounted() {
    void this.store.start()
  },
  beforeUnmount() {
    this.store.stop()
    this.guestNp.dispose()
  },
  methods: {
    async join() {
      const name = this.name.trim()
      if (!name) return
      this.joining = true
      this.joinError = ''
      try {
        await this.store.join(name)
      } catch (error) {
        if (error instanceof PartyApiError && error.status === 401) {
          this.store.showMessage('ended')
          return
        }
        if (error instanceof PartyApiError && error.status === 409) {
          this.joinError = this.$t('partyGuest.nameTaken')
          return
        }
        this.joinError =
          error instanceof PartyApiError && error.status === 503
            ? this.$t('partyGuest.full')
            : this.$t(guestErrorKey(error))
      } finally {
        this.joining = false
      }
    },
    notify(message: string) {
      this.toast = message
      this.toastOpen = true
    },
  },
}
</script>

<style scoped>
.guest-app__center {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}

.guest-app__join {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 320px;
  margin-top: 8px;
}

.guest-app__bar,
.guest-app__side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
}

.guest-app__bar {
  padding-top: calc(env(safe-area-inset-top) + 10px);
  background: var(--beacon-chrome);
  border-bottom: 1px solid var(--beacon-hairline);
}

.guest-app__brand {
  font-weight: 600;
  letter-spacing: 0.02em;
}

.guest-app__me {
  margin-left: auto;
  min-width: 0;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Where NowPlayingToolbar teleports its buttons on a phone. */
.guest-app__actions {
  display: flex;
  align-items: center;
  margin-left: 8px;
  flex-shrink: 0;
}

/* Between the app bar and the tab bar, scrolling on its own. */
.guest-app__page {
  height: calc(100dvh - 56px - 56px - env(safe-area-inset-top));
  overflow-y: auto;
  padding: 16px;
}

/* Now Playing fills the page edge to edge, its backdrop included. */
.guest-app__page--flush {
  padding: 0;
  overflow: hidden;
}

.guest-app__tabs {
  background: var(--beacon-chrome) !important;
  border-top: 1px solid var(--beacon-hairline);
}

.guest-app__desktop {
  height: 100dvh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(340px, 30vw, 440px);
}

.guest-app__stage {
  min-width: 0;
}

.guest-app__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--beacon-chrome);
  border-left: 1px solid var(--beacon-hairline);
}

/* Not flex-shrink alone: Vuetify's slide group grows (flex: 1 1 auto),
 * which in this column took half the height from the list under it. */
.guest-app__side-tabs {
  flex: 0 0 auto;
}

/* The app's tab labels: its own weight and case, not stock Material. */
.guest-app__side-tabs :deep(.v-tab) {
  text-transform: none;
  letter-spacing: normal;
}

.guest-app__side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 16px;
}
</style>
