<template>
  <!-- Title above, controls in a panel below — the grouping every settings
   - screen worth using has, and what lets a section be scanned as one
   - block instead of as loose paragraphs sharing a margin. Each setting
   - inside a panel is the same .setting primitive (label, control, hint),
   - separated by a hairline, so vertical rhythm comes from one rule rather
   - than from per-element utility margins that drifted apart. -->
  <v-container max-width="640" class="settings-view">
    <h1 class="page-title">{{ $t('settings.title') }}</h1>

    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.account') }}</h2>
      <div class="beacon-panel">
        <div class="account-strip">
          <div class="account-badge">
            <NavidromeIcon v-if="authStore.serverType === 'subsonic'" />
            <PlexIcon v-else-if="authStore.serverType === 'plex'" />
            <JellyfinIcon v-else />
          </div>
          <div class="account-info">
            <p class="account-info__url">{{ serverUrl }}</p>
            <p class="account-info__user text-medium-emphasis">{{ username }}</p>
          </div>
          <v-btn variant="text" color="error" size="small" @click="logout">
            {{ $t('settings.logout') }}
          </v-btn>
        </div>

        <div class="setting">
          <v-select
            v-model="locale"
            :items="localeOptions"
            :label="$t('settings.language')"
            variant="solo-filled"
            hide-details
            @update:model-value="onLocaleChange"
          />
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.playbackTitle') }}</h2>
      <div class="beacon-panel">
        <div class="setting">
          <p class="setting__label">{{ $t('settings.replayGain') }}</p>
          <segmented-control
            v-model="replayGainMode"
            :options="replayGainOptions"
            :label="$t('settings.replayGain')"
          />
          <p class="setting__hint">{{ $t('settings.replayGainHint') }}</p>
          <!-- Local playback on a phone runs without a Web Audio graph, which
           - is also what ReplayGain needs to change the level (see
           - webAudioAllowed() in services/audioEngine.ts) — saying so beats a
           - setting that silently does half of what it claims. -->
          <p v-if="!hasLocalGain" class="setting__hint">
            {{ $t('settings.replayGainMobileHint') }}
          </p>
        </div>

        <div class="setting">
          <p class="setting__label">{{ $t('settings.localQuality') }}</p>
          <div class="quality-row">
            <v-select
              :model-value="playbackStore.localQuality.format"
              :items="formatOptions"
              :label="$t('settings.qualityFormat')"
              variant="solo-filled"
              hide-details
              @update:model-value="playbackStore.setLocalQuality($event)"
            />
            <v-select
              v-if="playbackStore.localQuality.format !== 'original'"
              :model-value="playbackStore.localQuality.bitrate"
              :items="bitrateOptions(playbackStore.localQuality.format)"
              :label="$t('settings.qualityBitrate')"
              variant="solo-filled"
              hide-details
              @update:model-value="
                playbackStore.setLocalQuality(playbackStore.localQuality.format, $event)
              "
            />
          </div>
          <p class="setting__hint">{{ $t('settings.localQualityHint') }}</p>
        </div>

        <div class="setting">
          <p class="setting__label">{{ $t('settings.castQuality') }}</p>
          <div class="quality-row">
            <v-select
              :model-value="playbackStore.castQuality.format"
              :items="castFormatOptions"
              :label="$t('settings.qualityFormat')"
              variant="solo-filled"
              hide-details
              @update:model-value="playbackStore.setCastQuality($event)"
            />
            <v-select
              v-if="playbackStore.castQuality.format !== 'original'"
              :model-value="playbackStore.castQuality.bitrate"
              :items="bitrateOptions(playbackStore.castQuality.format)"
              :label="$t('settings.qualityBitrate')"
              variant="solo-filled"
              hide-details
              @update:model-value="
                playbackStore.setCastQuality(playbackStore.castQuality.format, $event)
              "
            />
          </div>
          <p class="setting__hint">{{ $t('settings.castQualityHint') }}</p>
        </div>

        <div class="setting">
          <v-switch
            :model-value="radioSettingsStore.castDirectly"
            color="primary"
            density="compact"
            hide-details
            :label="$t('settings.castRadioDirectly')"
            @update:model-value="radioSettingsStore.setCastDirectly(!!$event)"
          />
          <p class="setting__hint">{{ $t('settings.castRadioDirectlyHint') }}</p>
        </div>
      </div>
    </section>

    <!-- The section itself is unconditional, only what's inside it isn't:
     - the recommendations toggle at the bottom applies to every server and
     - every account, while the scan/refresh above it does not (a
     - non-admin Navidrome account has neither — see
     - services/capabilities.ts's libraryScan). Gating the whole <section>
     - on those, as it used to be, would take the toggle away with them. -->
    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.libraryTitle') }}</h2>
      <div class="beacon-panel">
        <div v-if="authStore.capabilities.libraryScan" class="setting">
          <p class="setting__description">{{ $t('settings.libraryScanHint') }}</p>
          <v-btn
            color="primary"
            prepend-icon="mdi-refresh"
            :loading="scanning"
            :disabled="scanning"
            @click="rescanLibrary"
          >
            {{ scanning ? scanLabel : $t('settings.rescanLibrary') }}
          </v-btn>
        </div>

        <!-- Jellyfin has no server-side scan-trigger of its own (see
         - capabilities.libraryScan) — this instead forces Beacon's own cached
         - view of the library to refetch now, rather than waiting for
         - CACHE_TTL_MS. Shows real progress since a large Jellyfin library can
         - take a couple of minutes (see stores/library.ts's refreshLibrary()). -->
        <div v-else-if="authStore.serverType === 'jellyfin'" class="setting">
          <p class="setting__description">{{ $t('settings.libraryRefreshHint') }}</p>
          <v-btn
            color="primary"
            prepend-icon="mdi-refresh"
            :loading="refreshingLibrary"
            :disabled="refreshingLibrary"
            @click="refreshLibrary"
          >
            {{ refreshingLibrary ? refreshProgressLabel : $t('settings.refreshLibrary') }}
          </v-btn>
          <v-progress-linear
            v-if="refreshingLibrary"
            class="settings-progress"
            :indeterminate="refreshProgressPercent === null"
            :model-value="refreshProgressPercent ?? undefined"
            color="primary"
            height="6"
            rounded
          />
        </div>

        <!-- Discover's seed artists come out of the library itself, which is
         - what puts this here rather than under "advanced" — it is an
         - everyday setting with a visible effect on Home (see
         - HomeView.vue), not a diagnostic one like the log level. -->
        <div class="setting">
          <v-switch
            :model-value="recommendationsStore.enabled"
            color="primary"
            density="compact"
            hide-details
            :label="$t('settings.recommendations')"
            @update:model-value="recommendationsStore.setEnabled(!!$event)"
          />
          <p class="setting__hint">{{ $t('settings.recommendationsHint') }}</p>
        </div>
      </div>
    </section>

    <!-- Opt-out, same convention as recommendations' toggle above — see
     - stores/lyricsProviders.ts's own comment on why every provider is
     - selected by default. Empty is still a valid, deliberate state (fully
     - opted out), not an error, so the hint below explains what it means
     - rather than the select complaining about it. -->
    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.lyricsProvidersTitle') }}</h2>
      <div class="beacon-panel">
        <div class="setting">
          <p class="setting__description">{{ $t('settings.lyricsProvidersHint') }}</p>
          <v-select
            :model-value="lyricsProvidersStore.enabled"
            :items="lyricProviders"
            :label="$t('settings.lyricsProviders')"
            variant="solo-filled"
            multiple
            chips
            closable-chips
            hide-details
            @update:model-value="lyricsProvidersStore.setEnabled($event)"
          />
          <p class="setting__hint">
            {{
              lyricsProvidersStore.enabled.length === 0
                ? $t('settings.lyricsProvidersEmptyHint')
                : $t('settings.lyricsProvidersActiveHint')
            }}
          </p>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.storageTitle') }}</h2>
      <div class="beacon-panel">
        <div class="setting">
          <p class="setting__description">{{ $t('settings.clearCacheHint') }}</p>
          <v-btn
            variant="tonal"
            prepend-icon="mdi-broom"
            :loading="clearingCache"
            :disabled="clearingCache"
            @click="clearCache"
          >
            {{ $t('settings.clearCache') }}
          </v-btn>
        </div>

        <div class="setting">
          <p class="setting__description">{{ $t('settings.resetAirplayHint') }}</p>
          <v-btn
            variant="tonal"
            prepend-icon="mdi-cast-off"
            :loading="resettingAirplay"
            @click="resetAirplayPairings"
          >
            {{ $t('settings.resetAirplay') }}
          </v-btn>
        </div>
      </div>
    </section>

    <!-- Unlike the library section above, this one has nothing else in it —
     - the whole section (title included) is gated, not just the control,
     - or a non-admin would see an empty "Advanced" heading with nothing
     - under it. See services/capabilities.ts's logLevelControl. -->
    <section v-if="authStore.capabilities.logLevelControl" class="settings-section">
      <h2 class="section-title">{{ $t('settings.advancedTitle') }}</h2>
      <div class="beacon-panel">
        <div class="setting">
          <p class="setting__description">{{ $t('settings.logLevelHint') }}</p>
          <v-select
            v-model="logLevel"
            :items="logLevelOptions"
            :label="$t('settings.logLevel')"
            :loading="logLevelBusy"
            :disabled="logLevelBusy || logLevel === null"
            variant="solo-filled"
            hide-details
            @update:model-value="onLogLevelChange"
          />
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="section-title">{{ $t('settings.about') }}</h2>
      <div class="beacon-panel">
        <div class="setting">
          <div class="about-actions">
            <v-btn variant="tonal" prepend-icon="mdi-star-circle-outline" @click="showReleaseNotes">
              {{ $t('settings.whatsNew') }}
            </v-btn>
            <!-- Sits with the other two rather than in a section of its own:
               - it answers the same kind of question they do — what is this
               - version, what can it do, who does it talk to — and a
               - one-button section would read as more ceremony than the
               - dialog behind it warrants. -->
            <v-btn
              variant="tonal"
              prepend-icon="mdi-shield-lock-outline"
              @click="privacyOpen = true"
            >
              {{ $t('privacy.title') }}
            </v-btn>
            <!-- The "?" key opens the same dialog, but nothing on screen says
             - so — this is where someone who has never pressed it finds out
             - the shortcuts exist at all. Which is also why it is not
             - offered on the phone layout: there is no keyboard to press
             - any of them with, and a list of key combinations is the one
             - thing a touch device can do nothing at all with. -->
            <v-btn
              v-if="!isMobileWeb"
              variant="tonal"
              prepend-icon="mdi-keyboard-outline"
              @click="showShortcuts"
            >
              {{ $t('shortcuts.title') }}
            </v-btn>
          </div>
        </div>

        <div class="setting">
          <div class="status-row">
            <span class="status-dot" :class="ffmpegFound ? 'status-dot--ok' : 'status-dot--warn'" />
            <span class="setting__hint setting__hint--inline">
              {{ ffmpegFound ? $t('settings.ffmpegFound') : $t('settings.ffmpegMissing') }}
            </span>
          </div>
          <p class="setting__hint">{{ $t('settings.version', { version: appVersion }) }}</p>
          <v-alert
            v-if="updateStore.available"
            type="info"
            variant="tonal"
            density="compact"
            class="settings-progress"
          >
            {{ $t('settings.updateAvailable', { version: updateStore.latestVersion }) }}
            <a
              v-if="updateStore.releaseUrl"
              :href="updateStore.releaseUrl"
              target="_blank"
              rel="noopener"
              class="update-link"
            >
              {{ $t('settings.updateAvailableLink') }}
            </a>
          </v-alert>
        </div>
      </div>
    </section>
    <privacy-dialog v-model="privacyOpen" />
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { clearLyricsCache } from '@/stores/lyrics'
import { clearCoverArtCache } from '@/services/connect/coverArtBatch'
import { clearRadioFaviconCache } from '@/services/connect/radioFaviconBatch'
import { getLocale, type SupportedLocale } from '@/i18n'
import { setLocale } from '@/services/localeSetting'
import { getLogLevel, setLogLevel, type LogLevel } from '@/services/connect/logLevel'
import { useRecommendationsStore } from '@/stores/recommendations'
import { useRadioSettingsStore } from '@/stores/radioSettings'
import { LYRIC_PROVIDERS, useLyricsProvidersStore } from '@/stores/lyricsProviders'
import { useUpdateStore } from '@/stores/update'
import type { ReplayGainMode } from '@/services/replayGain'
import { getAudioEngine } from '@/services/audioEngine'
import {
  BITRATES,
  CAST_FORMATS,
  LOCAL_FORMATS,
  type StreamFormat,
  type TranscodeFormat,
} from '@/services/streamQuality'
import PrivacyDialog from '@/components/settings/PrivacyDialog.vue'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import { useIsMobileWeb } from '@/composables/useIsMobileWeb'
import packageJson from '../../../../package.json'

// How often getScanStatus.view is polled while a scan is running — frequent
// enough that the live count feels responsive, not so frequent it hammers
// Navidrome for no real benefit (a scan takes at least several seconds even
// for a small library).
const SCAN_POLL_INTERVAL_MS = 2000

export default {
  name: 'SettingsView',
  components: { NavidromeIcon, JellyfinIcon, PlexIcon, PrivacyDialog, SegmentedControl },
  // Composition API escape hatch just for useIsMobileWeb() — everything
  // else stays Options API, same idiom as App.vue's identical use of it.
  setup() {
    return { isMobileWeb: useIsMobileWeb() }
  },
  data() {
    return {
      serverUrl: '',
      username: '',
      locale: getLocale(),
      appVersion: packageJson.version,
      // The wipe reaches three IndexedDB stores, the largest of which is a
      // whole library's worth of artwork — long enough on a big one that
      // the button has to say it is working rather than look ignored.
      clearingCache: false,
      privacyOpen: false,
      scanning: false,
      // How far the running scan has got, in whichever of the two ways the
      // server can say (see the client's ScanProgress): Navidrome counts
      // items, the Jellyfin and Plex bridges report a percentage, and
      // either can be null — hence scanLabel below rather than one fixed
      // string. Only meaningful while `scanning` is true.
      scanCount: null as number | null,
      scanPercent: null as number | null,
      scanTimer: null as ReturnType<typeof setTimeout> | null,
      resettingAirplay: false,
      // null until loadLogLevel() (created() below) resolves — the
      // v-select stays disabled/loading until then rather than guessing a
      // default that might not match what's actually configured backend-side.
      logLevel: null as LogLevel | null,
      logLevelBusy: false,
    }
  },
  computed: {
    // Whatever the server actually knows about the running scan: a count of
    // processed items (Navidrome), a percentage (the Jellyfin and Plex
    // bridges), or nothing at all — in which case it still has to say that
    // something is happening.
    scanLabel(): string {
      if (this.scanCount != null) return this.$t('settings.scanning', { count: this.scanCount })
      if (this.scanPercent != null) {
        return this.$t('settings.scanningPercent', { percent: this.scanPercent })
      }
      return this.$t('settings.scanningPlain')
    },
    authStore() {
      return useAuthStore()
    },
    connectStore() {
      return useConnectStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    updateStore() {
      return useUpdateStore()
    },
    recommendationsStore() {
      return useRecommendationsStore()
    },
    radioSettingsStore() {
      return useRadioSettingsStore()
    },
    lyricsProvidersStore() {
      return useLyricsProvidersStore()
    },
    lyricProviders() {
      return LYRIC_PROVIDERS
    },
    // Defaults to true (no warning dot) while health hasn't loaded yet —
    // ffmpeg being genuinely missing is rare enough that a false negative
    // for a split second on page load isn't worth the flicker.
    ffmpegFound() {
      return this.authStore.health?.ffmpeg ?? true
    },
    replayGainMode: {
      get(): ReplayGainMode {
        return this.playbackStore.replayGainMode
      },
      set(mode: ReplayGainMode) {
        this.playbackStore.setReplayGainMode(mode)
      },
    },
    /** Whether this device can apply ReplayGain to its own playback at all
     * — it rides on the same Web Audio graph the visualizer does. */
    hasLocalGain(): boolean {
      return getAudioEngine().hasAnalyser
    },
    replayGainOptions(): { title: string; value: ReplayGainMode }[] {
      return [
        { title: this.$t('settings.replayGainOff'), value: 'off' },
        { title: this.$t('settings.replayGainTrack'), value: 'song' },
        { title: this.$t('settings.replayGainAlbum'), value: 'album' },
      ]
    },
    /** Both lists come from services/streamQuality.ts rather than being
     * written out here — which formats each side can offer is a fact about
     * the encoders and the seeking, not a UI decision, and it's explained
     * where it's decided. */
    formatOptions(): { title: string; value: StreamFormat }[] {
      return LOCAL_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    castFormatOptions(): { title: string; value: StreamFormat }[] {
      return CAST_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    localeOptions() {
      return [
        { title: 'Deutsch', value: 'de' },
        { title: 'English', value: 'en' },
        { title: 'Español', value: 'es' },
        { title: 'Français', value: 'fr' },
        { title: 'Italiano', value: 'it' },
      ]
    },
    logLevelOptions() {
      return [
        { title: this.$t('settings.logLevelTrace'), value: 'TRACE' },
        { title: this.$t('settings.logLevelDebug'), value: 'DEBUG' },
        { title: this.$t('settings.logLevelInfo'), value: 'INFO' },
        { title: this.$t('settings.logLevelWarning'), value: 'WARNING' },
        { title: this.$t('settings.logLevelError'), value: 'ERROR' },
      ]
    },
    refreshingLibrary() {
      return this.libraryStore.songScanProgress !== null
    },
    refreshProgressPercent() {
      const progress = this.libraryStore.songScanProgress
      if (!progress || !progress.total) return null
      return Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    },
    refreshProgressLabel() {
      const progress = this.libraryStore.songScanProgress
      if (!progress) return ''
      return progress.total
        ? this.$t('settings.refreshingLibraryWithTotal', {
            loaded: progress.loaded,
            total: progress.total,
          })
        : this.$t('settings.refreshingLibrary', { loaded: progress.loaded })
    },
  },
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
    // Skip the fetch entirely for an account that can't see the control
    // this feeds (capabilities.logLevelControl) — no point asking connect
    // for something nobody here can act on.
    if (this.authStore.capabilities.logLevelControl) void this.loadLogLevel()
  },
  beforeUnmount() {
    if (this.scanTimer) clearTimeout(this.scanTimer)
  },
  methods: {
    formatLabel(format: StreamFormat): string {
      return format === 'original' ? this.$t('settings.qualityOriginal') : format.toUpperCase()
    },
    bitrateOptions(format: TranscodeFormat): { title: string; value: number }[] {
      return BITRATES[format].map((value) => ({
        title: this.$t('settings.qualityBitrateItem', { value }),
        value,
      }))
    },
    onLocaleChange(value: SupportedLocale) {
      setLocale(value)
    },
    // Reads back whatever's actually configured backend-side (Settings'
    // own last choice, or the DEBUG env var fallback on a deployment that's
    // never touched this before — see core/log_level.py) rather than
    // guessing a default that could silently disagree with it.
    async loadLogLevel() {
      try {
        const { level } = await getLogLevel()
        this.logLevel = level
      } catch (error) {
        console.error('[settings] Failed to load log level:', error)
      }
    },
    async onLogLevelChange(value: LogLevel) {
      this.logLevelBusy = true
      try {
        await setLogLevel(value)
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChanged'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChangeFailed'),
        })
        console.error('[settings] Failed to set log level:', error)
        void this.loadLogLevel() // re-sync the dropdown with what's actually active
      } finally {
        this.logLevelBusy = false
      }
    },
    async logout() {
      await this.authStore.logout()
      this.$router.push('/login')
    },
    showShortcuts() {
      this.$emitter.emit('toggleKeyboardShortcuts')
    },
    showReleaseNotes() {
      this.$emitter.emit('openReleaseNotes')
    },
    async rescanLibrary() {
      this.scanning = true
      this.scanCount = null
      this.scanPercent = null
      try {
        const status = await this.libraryStore.client().startScan()
        this.scanCount = status.count
        this.scanPercent = status.percent
      } catch (error) {
        this.scanning = false
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.rescanLibrary'),
          message: this.$t('settings.scanFailed'),
        })
        console.error('[settings] Failed to start library scan:', error)
        return
      }
      void this.pollScanStatus()
    },
    // Navidrome's Subsonic extension has no push notification for "scan
    // finished" — polling getScanStatus.view until `scanning` flips back to
    // false is the only way to know. Schedules its own next tick via
    // setTimeout rather than setInterval, so a slow response can't ever
    // stack a second poll on top of one still in flight.
    async pollScanStatus() {
      let status
      try {
        status = await this.libraryStore.client().getScanStatus()
      } catch (error) {
        this.scanning = false
        console.error('[settings] Failed to poll library scan status:', error)
        return
      }
      this.scanCount = status.count
      this.scanPercent = status.percent
      if (status.scanning) {
        this.scanTimer = setTimeout(() => this.pollScanStatus(), SCAN_POLL_INTERVAL_MS)
        return
      }
      this.scanning = false
      // A scan can add, remove, or re-tag songs — without this, Beacon
      // would keep showing whatever it already had cached in memory until
      // the app restarts, same "missing songs never appear" complaint
      // that prompted this feature in the first place.
      void this.libraryStore.invalidateCache()
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.rescanLibrary'),
        message: this.$t('settings.scanComplete', { count: this.scanCount }),
      })
    },
    async refreshLibrary() {
      try {
        await this.libraryStore.refreshLibrary()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.refreshLibrary'),
          message: this.$t('settings.libraryRefreshed', {
            count: this.libraryStore.allSongs.length,
          }),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.refreshLibrary'),
          message: this.$t('settings.refreshLibraryFailed'),
        })
        console.error('[settings] Failed to refresh library:', error)
      }
    },
    // Distinct from rescanLibrary()/refreshLibrary() above — those ask the
    // *server* to look for actual changes; this just throws away Beacon's
    // own locally-cached copies so the next view that needs them fetches
    // fresh, without necessarily implying anything on the server side has
    // changed. Waveforms aren't cached at all anymore (see
    // services/connect/waveform.ts) — a fresh decode is well under a
    // second, not worth keeping a cache around for.
    //
    // Artwork and radio logos belong here as much as the library and
    // lyrics do, and for a while did not get cleared at all: clearing
    // cover art has only ever been wired to switching accounts
    // (accountScopedStores.ts), and station logos had no way to be cleared
    // outside a test. Artwork is by some distance the largest of the four,
    // so a "clear cache" that left it behind cleared almost nothing of
    // what anyone means by it.
    //
    // Awaited rather than fired off, because the three that reach
    // IndexedDB return before the deletion has actually happened — the
    // success toast used to appear over caches that were still there, and
    // a reload right behind it could abort the wipe outright.
    async clearCache() {
      this.clearingCache = true
      try {
        await Promise.all([
          this.libraryStore.invalidateCache(),
          clearLyricsCache(),
          clearCoverArtCache(),
        ])
        clearRadioFaviconCache()
      } finally {
        this.clearingCache = false
      }
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.clearCache'),
        message: this.$t('settings.cacheCleared'),
      })
    },
    // Forgets every paired AirPlay device's stored credentials (see
    // delivery/credentials.py) — each one needs pairing again on next use,
    // same as unpairing them one by one from the device picker
    // (ConnectDevicePicker.vue) would, just in bulk. Doesn't touch anything
    // Sonos/Chromecast/DLNA — those have no pairing step of their own.
    async resetAirplayPairings() {
      this.resettingAirplay = true
      try {
        await this.connectStore.unpairAll()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayReset'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayResetFailed'),
        })
        console.error('[settings] Failed to reset AirPlay pairings:', error)
      } finally {
        this.resettingAirplay = false
      }
    },
  },
}
</script>

<style scoped>
.settings-section {
  margin-bottom: 28px;
}

.settings-section .section-title {
  margin-bottom: 10px;
}

/* One surface per section, rather than every control floating directly on
 * the page. Same treatment .account-strip already used on its own, now the
 * container for a whole group — which is also why that strip no longer
 * draws a second border inside this one. The surface itself is the app's
 * shared .beacon-panel (assets/base.css), where this page's own version of
 * it now lives; the track-info dialog sits on the same one. */

/* The vertical rhythm of the whole page, in one rule. Every setting is
 * this block, and the separator only exists between siblings — so a
 * section whose first control is conditionally absent (the library scan on
 * a non-admin account) closes up on its own, with no margin class needing
 * to know whether anything above it rendered. */
/* The account strip is not a .setting, so without naming it here the
 * separator that every other block in a panel gets simply skipped the one
 * place two different kinds of block meet — account above, language below.
 *
 * Naming it in *this* rule rather than giving the strip a border of its own
 * is the whole point: a line needs the 18px above and below it that this
 * rule provides. Drawn on the strip alone it lands flush against the filled
 * select underneath and is invisible for it, which is exactly how it looked
 * on the first attempt. */
.setting + .setting,
.account-strip + .setting {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--beacon-hairline);
}

.setting__label {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 10px;
}

/* Reads before the control it introduces; the hint below reads after one.
 * Two names rather than one class plus a modifier, because which side of
 * the control a line belongs on is the whole difference between them. */
.setting__description {
  margin-bottom: 12px;
}

/* The quieter line under a control, so a setting reads as
 * label-then-explanation rather than as two equal lines. Values match
 * Vuetify's own body-small / medium-emphasis deliberately: the rest of the
 * app uses those, and a hint sitting a hair off would read as a mistake
 * rather than a choice. */
.setting__description,
.setting__hint {
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.3333333333;
  letter-spacing: 0.0333333333em;
  color: color-mix(
    in srgb,
    rgb(var(--v-theme-on-background)) calc(var(--v-medium-emphasis-opacity) * 100%),
    transparent
  );
}

.setting__hint {
  margin-top: 8px;
}

/* Already sitting next to the status dot on its own row, so the stacking
 * margin would only push it off that line. */
.setting__hint--inline {
  margin-top: 0;
}

/* Format and bitrate side by side, with the format wider — it carries the
 * actual decision, while the bitrate is a number that needs no room. Wraps
 * on a narrow window (the mobile web build) instead of squeezing both into
 * something unreadable. */
.quality-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.quality-row > :first-child {
  flex: 2 1 180px;
}

.quality-row > :last-child:not(:first-child) {
  flex: 1 1 120px;
}

/* Echoes ServerLoginView.vue's lit account badge — the same signal that
 * confirmed which server you signed into now confirms who you're signed in
 * as, a deliberate bookend rather than a plain read-only form field. No
 * border or surface of its own any more: the panel around it draws both,
 * and two nested hairlines read as a mistake. */
.account-strip {
  display: flex;
  align-items: center;
  gap: 14px;
}

.account-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 22px;
  flex-shrink: 0;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 16px rgba(var(--v-theme-primary), 0.2);
}

.account-info {
  flex: 1;
  min-width: 0;
}

.account-info__url {
  font-weight: 600;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-info__user {
  font-size: 0.8rem;
  margin-top: 2px;
}

/* A small lit/unlit signal rather than a full-width alert banner — same
 * "beacon" idea as everything else here, just dialed down to the size the
 * fact actually deserves (ffmpeg being present is the normal case). */
.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot--ok {
  background: rgb(var(--v-theme-success));
  box-shadow: 0 0 6px 1px rgba(95, 180, 137, 0.5);
}

.status-dot--warn {
  background: rgb(var(--v-theme-warning));
  box-shadow: 0 0 6px 1px rgba(242, 169, 59, 0.5);
}

.update-link {
  margin-left: 0.4em;
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* A phone has no room to spend on panel padding, and the account row runs
 * out of width first: its two lines and the logout button stop fitting on
 * one line well before the panel itself is tight. Everything else already
 * stacks on its own (.quality-row wraps, every control is full-width). */
@media (max-width: 600px) {
  /* Scoped, so this tightens the panels on this page only - a dialog's
   * panels have their own answer to a narrow window. */
  .beacon-panel {
    padding: 14px;
    border-radius: 12px;
  }

  .settings-section {
    margin-bottom: 22px;
  }

  /* One row here too, the same shape as on the desktop — only tighter.
   * What gives when there is not enough width is the URL, which already
   * ellipsises (see .account-info__url); it is the one part of this row
   * that can lose its tail and still say what it says. Wrapping instead
   * put the button on a line of its own under the username, where it read
   * as a third line of account text rather than as an action. */
  .account-strip {
    gap: 10px;
  }

  .account-strip > .v-btn {
    flex-shrink: 0;
  }
}

.page-title {
  margin-bottom: 24px;
}

/* A progress bar or notice that appears under the control it belongs to. */
.settings-progress {
  margin-top: 12px;
}
</style>
