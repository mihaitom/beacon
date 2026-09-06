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
          <!-- The label with the recommendations beside it. Which format
           - and which number to pick is not something a listener can read
           - off the two dropdowns, and the hint under them explains what
           - the setting *is* rather than what to choose — so the advice
           - sits where the question is asked, out of the way until it is
           - wanted. -->
          <div class="setting__label-row">
            <p class="setting__label setting__label--inline">
              {{ $t('settings.localQuality') }}
            </p>
            <quality-tips :lines="localQualityTips" />
          </div>
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
          <div class="setting__label-row">
            <p class="setting__label setting__label--inline">
              {{ $t('settings.castQuality') }}
            </p>
            <quality-tips :lines="castQualityTips" />
          </div>
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
          <p class="setting__description">
            {{ $t('settings.libraryScanHint', { server: serverName }) }}
          </p>
          <!-- The label stays put while the scan runs; the progress is the
             - ring in the button and the figure beside it. Vuetify hides a
             - loading button's own content (`.v-btn__content { opacity: 0 }`)
             - but keeps it in the layout, so a label swapped for a progress
             - one was invisible *and* still sized the button: it shrank on
             - the first click, grew again with every digit the count gained,
             - and snapped back to full width at the end. -->
          <div class="setting__control-row">
            <v-btn
              color="primary"
              prepend-icon="mdi-refresh"
              :loading="scanning"
              :disabled="scanning"
              @click="rescanLibrary"
            >
              <!-- The spinner Vuetify would draw, made to say how far
                 - along the scan is wherever the server knows: Jellyfin and
                 - Plex report a percentage, Navidrome counts items with no
                 - total to divide by and so keeps the ring turning
                 - instead. -->
              <template #loader>
                <v-progress-circular
                  :indeterminate="scanPercent === null"
                  :model-value="scanPercent ?? undefined"
                  size="24"
                  width="2"
                />
              </template>
              {{ $t('settings.rescanLibrary') }}
            </v-btn>
            <!-- Beside the button rather than under it: it is the state of
               - that button, not a note about the section, and a ring that
               - only turns (Navidrome, which counts items with no total)
               - needs the number to say anything at all. -->
            <span v-if="scanning" class="setting__status">{{ scanLabel }}</span>
          </div>
        </div>

        <!-- Jellyfin has no server-side scan-trigger of its own (see
         - capabilities.libraryScan) — this instead forces Beacon's own cached
         - view of the library to refetch now, rather than waiting for
         - CACHE_TTL_MS. Shows real progress since a large Jellyfin library can
         - take a couple of minutes (see stores/library.ts's refreshLibrary()). -->
        <div v-else-if="authStore.serverType === 'jellyfin'" class="setting">
          <p class="setting__description">{{ $t('settings.libraryRefreshHint') }}</p>
          <!-- Same fixed label, same reason as the scan button above. This
             - one already had somewhere to put its progress; it now carries
             - the count as well, which used to be written invisibly into the
             - button. -->
          <v-btn
            color="primary"
            prepend-icon="mdi-refresh"
            :loading="refreshingLibrary"
            :disabled="refreshingLibrary"
            @click="refreshLibrary"
          >
            {{ $t('settings.refreshLibrary') }}
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
          <p v-if="refreshingLibrary && refreshProgressLabel" class="setting__hint">
            {{ refreshProgressLabel }}
          </p>
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
  localFormats,
  type StreamFormat,
  type TranscodeFormat,
} from '@/services/streamQuality'
import PrivacyDialog from '@/components/settings/PrivacyDialog.vue'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import QualityTips from '@/components/settings/QualityTips.vue'
import { useIsMobileWeb } from '@/composables/useIsMobileWeb'
import packageJson from '../../../../package.json'

export default {
  name: 'SettingsView',
  components: {
    NavidromeIcon,
    JellyfinIcon,
    PlexIcon,
    PrivacyDialog,
    QualityTips,
    SegmentedControl,
  },
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
    /** What to call the media server in the text next to the scan button.
     * All three server types show that button (it is gated on being an
     * admin, not on which server it is), and it used to tell a Plex or
     * Jellyfin admin that Navidrome was about to scan their files. Same
     * three names the login screen offers. */
    serverName(): string {
      if (this.authStore.serverType === 'jellyfin') return this.$t('auth.serverTypeJellyfin')
      if (this.authStore.serverType === 'plex') return this.$t('auth.serverTypePlex')
      return this.$t('auth.serverTypeSubsonic')
    },

    /** The scan is the library store's, not this page's — it outlives the
     * page (see its startScan()). These three only read it. */
    scanning(): boolean {
      return this.libraryStore.scanning
    },
    scanCount(): number | null {
      return this.libraryStore.scanCount
    },
    scanPercent(): number | null {
      return this.libraryStore.scanPercent
    },
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
     * where it's decided.
     *
     * The local one is a call rather than a constant because it depends on
     * the browser this is running in: Safari decodes no Ogg, so Opus is
     * simply not among its choices. */
    formatOptions(): { title: string; value: StreamFormat }[] {
      return localFormats().map((value) => ({ title: this.formatLabel(value), value }))
    },
    castFormatOptions(): { title: string; value: StreamFormat }[] {
      return CAST_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    /** The advice behind the info button, one line each.
     *
     * Two different sets of advice, because the two settings answer
     * different questions. On this device the question is how much data
     * to pull over whatever connection it happens to be on, which is why
     * that list talks about being out and about — and Opus is left out of
     * it entirely where this browser cannot play it, since recommending
     * something that is not in the dropdown reads as a bug in the
     * dropdown. A speaker is on the same network as connect and pulls
     * from it there, so data size is not what anyone is weighing: the cast
     * list is about when a limit is worth setting at all, and what a
     * device that struggles wants instead. Which format each device
     * actually gets is still connect's decision (see _codec_for_ceiling()
     * in core/streamer.py) — the setting is the listener's wish. */
    localQualityTips(): string[] {
      const lines = [
        this.$t('settings.qualityTips.ceiling'),
        this.$t('settings.qualityTips.home'),
        this.$t('settings.qualityTips.mobile'),
      ]
      if (localFormats().includes('opus')) lines.push(this.$t('settings.qualityTips.slow'))
      lines.push(this.$t('settings.qualityTips.compatibility'))
      return lines
    },
    castQualityTips(): string[] {
      return [
        this.$t('settings.qualityTips.ceiling'),
        this.$t('settings.qualityTips.castDefault'),
        this.$t('settings.qualityTips.castWhenNeeded'),
        this.$t('settings.qualityTips.castCompatibility'),
        this.$t('settings.qualityTips.castDevice'),
      ]
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
    // A scan may already be running — one this app started before a
    // restart, or one somebody kicked off on the server itself. Asked
    // once, and only where the control that shows it exists.
    if (this.authStore.capabilities.libraryScan) void this.libraryStore.resumeScanIfRunning()
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
    /** Hands the whole scan to the library store — see its startScan() for
     * why it lives there and not here. Only the "could not even start"
     * case is this page's to report; everything after that is announced
     * wherever the person happens to be by then. */
    async rescanLibrary() {
      try {
        await this.libraryStore.startScan()
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.rescanLibrary'),
          message: this.$t('settings.scanFailed'),
        })
        console.error('[settings] Failed to start library scan:', error)
      }
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

/* A control and whatever it has to say about itself, side by side, and
 * wrapping under each other where there is no room. */
.setting__control-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

/* Tabular figures, because this counts upwards: proportional digits make
 * the whole line twitch on every poll. */
.setting__status {
  font-variant-numeric: tabular-nums;
}

.setting__label {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 10px;
}

/* A label that shares its line with the info button next to it, so the
 * button sits on the text's baseline row rather than below the gap the
 * label reserves for the control under it. */
.setting__label-row {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 10px;
}

.setting__label--inline {
  margin-bottom: 0;
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
.setting__hint,
.setting__status {
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
